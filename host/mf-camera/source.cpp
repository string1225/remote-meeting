// Windows Frame Server media source. Capture and composition stay in the host worker.
#include "protocol.h"
#include <unknwn.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mferror.h>
#include <ks.h>
#include <ksmedia.h>
#include <wrl.h>
#include <propvarutil.h>
#include <vector>
#include <deque>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <new>
#include <string>
#include <algorithm>
#include <utility>

// The SDK declares this interface only for kernel builds; user-mode media
// sources use the same ksproxy ABI without depending on the WDK headers.
#ifndef _IKsControl_
#define _IKsControl_
struct __declspec(uuid("28F54685-06FD-11D2-B27A-00A0C9223196")) IKsControl : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE KsProperty(PKSPROPERTY, ULONG, void*, ULONG, ULONG*) = 0;
    virtual HRESULT STDMETHODCALLTYPE KsMethod(PKSMETHOD, ULONG, void*, ULONG, ULONG*) = 0;
    virtual HRESULT STDMETHODCALLTYPE KsEvent(PKSEVENT, ULONG, void*, ULONG, ULONG*) = 0;
};
#endif

using namespace Microsoft::WRL;
#define CHECK(call) do { HRESULT rmcResult = (call); if (FAILED(rmcResult)) return rmcResult; } while (0)
using Clock = std::chrono::steady_clock;

static std::wstring FramePath() {
    wchar_t path[32768]; DWORD size = sizeof(path);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, ConfigKey, L"FramePath", RRF_RT_REG_SZ, nullptr, path, &size) != ERROR_SUCCESS) return {};
    return path;
}

class FrameReader {
    HANDLE file = INVALID_HANDLE_VALUE, mapping = nullptr;
    const BYTE* view = nullptr;
    std::vector<BYTE> snapshot, pending;
    uint32_t width = 0, height = 0;
    uint64_t lastTick = 0;
    std::wstring configuredPath;
public:
    ~FrameReader() { Close(); }
    void SetPath(std::wstring path) { Close(); configuredPath = std::move(path); }
    void Close() {
        if (view) UnmapViewOfFile(view);
        if (mapping) CloseHandle(mapping);
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        view = nullptr; mapping = nullptr; file = INVALID_HANDLE_VALUE;
        snapshot.clear(); pending.clear(); width = height = 0; lastTick = 0;
    }
    bool Read() {
        if (!view) {
            auto path = configuredPath.empty() ? FramePath() : configuredPath; if (path.empty()) return false;
            file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, 0, nullptr);
            if (file == INVALID_HANDLE_VALUE) return false;
            LARGE_INTEGER size{};
            if (!GetFileSizeEx(file, &size) || size.QuadPart < MappingBytes) { Close(); return false; }
            mapping = CreateFileMappingW(file, nullptr, PAGE_READONLY, 0, 0, nullptr);
            if (!mapping) { Close(); return false; }
            view = static_cast<const BYTE*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, MappingBytes));
            if (!view) { Close(); return false; }
            snapshot.resize(MaxFrameBytes);
            pending.resize(MaxFrameBytes);
        }
        auto header = reinterpret_cast<const FrameHeader*>(view);
        for (int attempt = 0; attempt < 4; ++attempt) {
            LONG before = header->sequence; MemoryBarrier();
            if (before & 1) { SwitchToThread(); continue; }
            FrameHeader data; memcpy(&data, view, sizeof(data));
            if (data.magic != FrameMagic || data.version != FrameVersion || !data.active ||
                data.width < 2 || data.height < 2 || data.width > MaxWidth || data.height > MaxHeight ||
                (data.width & 1) || (data.height & 1) || data.bytes != data.width * data.height * 3 / 2 ||
                GetTickCount64() - data.tickMs > 2000) { lastTick = 0; return false; }
            memcpy(pending.data(), view + sizeof(FrameHeader), data.bytes);
            MemoryBarrier();
            if (header->sequence != before) continue;
            snapshot.swap(pending);
            width = data.width; height = data.height; lastTick = data.tickMs; return true;
        }
        return lastTick && GetTickCount64() - lastTick <= 2000;
    }
    void CopyNv12(BYTE* output, LONG pitch, uint32_t w, uint32_t h, bool available) {
        BYTE* uv = output + size_t(pitch) * h;
        if (!available) {
            for (uint32_t y = 0; y < h; ++y) memset(output + size_t(pitch) * y, 16, w);
            for (uint32_t y = 0; y < h / 2; ++y) memset(uv + size_t(pitch) * y, 128, w);
            return;
        }
        if (w == width && h == height) {
            for (uint32_t y = 0; y < h; ++y) memcpy(output + size_t(pitch) * y, snapshot.data() + size_t(width) * y, w);
            for (uint32_t y = 0; y < h / 2; ++y) memcpy(uv + size_t(pitch) * y, snapshot.data() + size_t(width) * height + size_t(width) * y, w);
            return;
        }
        for (uint32_t y = 0; y < h; ++y) {
            const BYTE* row = snapshot.data() + size_t(y * height / h) * width;
            for (uint32_t x = 0; x < w; ++x) output[size_t(pitch) * y + x] = row[x * width / w];
        }
        for (uint32_t y = 0; y < h / 2; ++y) {
            const BYTE* row = snapshot.data() + size_t(width) * height + size_t(y * height / h) * width;
            for (uint32_t x = 0; x < w; x += 2) {
                uint32_t sourceX = (x * width / w) & ~1u;
                uv[size_t(pitch) * y + x] = row[sourceX]; uv[size_t(pitch) * y + x + 1] = row[sourceX + 1];
            }
        }
    }
    void CopyYuy2(BYTE* output, LONG pitch, uint32_t w, uint32_t h, bool available) {
        for (uint32_t y = 0; y < h; ++y) {
            BYTE* dest = output + size_t(pitch) * y;
            if (!available) {
                for (uint32_t x = 0; x < w; x += 2) { dest[2*x] = dest[2*x+2] = 16; dest[2*x+1] = dest[2*x+3] = 128; }
                continue;
            }
            uint32_t sy = y * height / h;
            const BYTE* row = snapshot.data() + size_t(sy) * width;
            const BYTE* uv = snapshot.data() + size_t(width) * height + size_t(sy / 2) * width;
            for (uint32_t x = 0; x < w; x += 2) {
                uint32_t sx = x * width / w, cx = sx & ~1u;
                dest[2*x] = row[sx]; dest[2*x+1] = uv[cx];
                dest[2*x+2] = row[(x+1) * width / w]; dest[2*x+3] = uv[cx+1];
            }
        }
    }
};

class MediaSource;
class MediaStream final : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
    ChainInterfaces<IMFMediaStream2, IMFMediaStream, IMFMediaEventGenerator>, FtmBase> {
    std::mutex mutex;
    std::condition_variable wake;
    ComPtr<IMFMediaEventQueue> events;
    ComPtr<IMFStreamDescriptor> descriptor;
    ComPtr<IMFAttributes> attributes;
    ComPtr<IMFMediaSource> parent;
    ComPtr<IMFVideoSampleAllocatorEx> allocator;
    bool allocatorInitialized = false, shutdown = false, running = false;
    MF_STREAM_STATE streamState = MF_STREAM_STATE_STOPPED;
    std::deque<ComPtr<IUnknown>> requests;
    std::thread worker;
    uint32_t width = 1920, height = 1080;
    GUID format = MFVideoFormat_NV12;
    uint64_t generation = 0;
    FrameReader frames;
    Clock::time_point nextFrame{};
    LONGLONG sampleTime = 0;

    HRESULT CreateSample(IUnknown* token, IMFSample** sample) {
        ComPtr<IMFSample> result;
        if (allocatorInitialized) CHECK(allocator->AllocateSample(&result));
        else {
            CHECK(MFCreateSample(&result));
            ComPtr<IMFMediaBuffer> memory;
            CHECK(MFCreateMemoryBuffer(width * height * (format == MFVideoFormat_NV12 ? 3 : 4) / 2, &memory));
            CHECK(result->AddBuffer(memory.Get()));
        }
        ComPtr<IMFMediaBuffer> buffer; CHECK(result->GetBufferByIndex(0, &buffer));
        bool available = frames.Read();
        ComPtr<IMF2DBuffer2> twoD;
        if (SUCCEEDED(buffer.As(&twoD))) {
            BYTE* start = nullptr; BYTE* origin = nullptr; LONG pitch = 0; DWORD length = 0;
            CHECK(twoD->Lock2DSize(MF2DBuffer_LockFlags_Write, &start, &pitch, &origin, &length));
            if (pitch < LONG(width * (format == MFVideoFormat_NV12 ? 1 : 2)) ||
                length < size_t(pitch) * height * (format == MFVideoFormat_NV12 ? 3 : 2) / 2) { twoD->Unlock2D(); return MF_E_BUFFERTOOSMALL; }
            if (format == MFVideoFormat_NV12) frames.CopyNv12(start, pitch, width, height, available);
            else frames.CopyYuy2(start, pitch, width, height, available);
            CHECK(twoD->Unlock2D());
        } else {
            BYTE* data = nullptr; DWORD maximum = 0;
            CHECK(buffer->Lock(&data, &maximum, nullptr));
            DWORD bytes = width * height * (format == MFVideoFormat_NV12 ? 3 : 4) / 2;
            if (maximum < bytes) { buffer->Unlock(); return MF_E_BUFFERTOOSMALL; }
            if (format == MFVideoFormat_NV12) frames.CopyNv12(data, width, width, height, available);
            else frames.CopyYuy2(data, width * 2, width, height, available);
            CHECK(buffer->Unlock()); CHECK(buffer->SetCurrentLength(bytes));
        }
        CHECK(buffer->SetCurrentLength(width * height * (format == MFVideoFormat_NV12 ? 3 : 4) / 2));
        CHECK(result->SetSampleTime(sampleTime)); CHECK(result->SetSampleDuration(10000000 / 30));
        CHECK(result->SetUINT32(MFSampleExtension_CleanPoint, TRUE));
        if (token) CHECK(result->SetUnknown(MFSampleExtension_Token, token));
        sampleTime += 10000000 / 30;
        return result.CopyTo(sample);
    }
    void Work() noexcept {
        HRESULT apartment = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        std::unique_lock<std::mutex> lock(mutex);
        while (!shutdown) {
            wake.wait(lock, [&] { return shutdown || (running && !requests.empty()); });
            if (shutdown) break;
            uint64_t version = generation;
            if (wake.wait_until(lock, nextFrame, [&] { return shutdown || !running || version != generation; })) continue;
            ComPtr<IUnknown> token = requests.front(); requests.pop_front();
            ComPtr<IMFSample> sample;
            HRESULT hr;
            try { hr = CreateSample(token.Get(), &sample); } catch (...) { hr = E_OUTOFMEMORY; }
            nextFrame = (std::max)(nextFrame + std::chrono::nanoseconds(1000000000 / 30), Clock::now());
            if (SUCCEEDED(hr)) events->QueueEventParamUnk(MEMediaSample, GUID_NULL, S_OK, sample.Get());
            else if (hr == MF_E_SAMPLEALLOCATOR_EMPTY) { requests.push_front(token); }
            else events->QueueEventParamVar(MEError, GUID_NULL, hr, nullptr);
        }
        lock.unlock(); if (SUCCEEDED(apartment)) CoUninitialize();
    }
public:
    ~MediaStream() { Shutdown(); }
    HRESULT Initialize(IMFMediaSource* source, std::wstring path) {
        parent = source;
        frames.SetPath(std::move(path));
        CHECK(MFCreateEventQueue(&events)); CHECK(MFCreateAttributes(&attributes, 8));
        CHECK(attributes->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE));
        CHECK(attributes->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0));
        CHECK(attributes->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1));
        std::vector<ComPtr<IMFMediaType>> types;
        for (auto dimensions : { std::pair<UINT32,UINT32>{1920,1080}, {1280,720}, {640,360} }) {
            for (GUID subtype : { MFVideoFormat_NV12, MFVideoFormat_YUY2 }) {
                ComPtr<IMFMediaType> type; CHECK(MFCreateMediaType(&type));
                CHECK(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)); CHECK(type->SetGUID(MF_MT_SUBTYPE, subtype));
                CHECK(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, dimensions.first, dimensions.second));
                CHECK(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, 30, 1));
                CHECK(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1));
                CHECK(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive));
                CHECK(type->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE));
                CHECK(type->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE));
                CHECK(type->SetUINT32(MF_MT_DEFAULT_STRIDE, dimensions.first * (subtype == MFVideoFormat_NV12 ? 1 : 2)));
                CHECK(type->SetUINT32(MF_MT_SAMPLE_SIZE, dimensions.first * dimensions.second * (subtype == MFVideoFormat_NV12 ? 3 : 4) / 2));
                CHECK(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235));
                CHECK(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT601));
                types.push_back(type);
            }
        }
        std::vector<IMFMediaType*> raw; for (auto& type : types) raw.push_back(type.Get());
        CHECK(MFCreateStreamDescriptor(0, DWORD(raw.size()), raw.data(), &descriptor));
        ComPtr<IMFMediaTypeHandler> handler; CHECK(descriptor->GetMediaTypeHandler(&handler));
        CHECK(handler->SetCurrentMediaType(types[0].Get()));
        worker = std::thread([this] { Work(); }); return S_OK;
    }
    HRESULT Start(IMFMediaType* type) {
        std::lock_guard<std::mutex> lock(mutex);
        if (shutdown) return MF_E_SHUTDOWN;
        UINT32 w=0,h=0; GUID subtype{};
        CHECK(MFGetAttributeSize(type, MF_MT_FRAME_SIZE, &w, &h)); CHECK(type->GetGUID(MF_MT_SUBTYPE, &subtype));
        ComPtr<IMFMediaTypeHandler> handler; CHECK(descriptor->GetMediaTypeHandler(&handler));
        CHECK(handler->IsMediaTypeSupported(type, nullptr)); CHECK(handler->SetCurrentMediaType(type));
        if (allocatorInitialized) { allocator->UninitializeSampleAllocator(); allocatorInitialized = false; }
        if (allocator) { CHECK(allocator->InitializeSampleAllocatorEx(3, 8, nullptr, type)); allocatorInitialized = true; }
        width=w; height=h; format=subtype; generation++; requests.clear();
        sampleTime=MFGetSystemTime(); nextFrame=Clock::now(); running=true; streamState=MF_STREAM_STATE_RUNNING;
        PROPVARIANT time{}; InitPropVariantFromInt64(sampleTime,&time);
        CHECK(events->QueueEventParamVar(MEStreamStarted,GUID_NULL,S_OK,&time)); PropVariantClear(&time);
        wake.notify_all(); return S_OK;
    }
    HRESULT Stop() {
        std::lock_guard<std::mutex> lock(mutex);
        if (shutdown) return MF_E_SHUTDOWN;
        running=false; streamState=MF_STREAM_STATE_STOPPED; generation++; requests.clear(); wake.notify_all();
        frames.Close(); if(allocatorInitialized){allocator->UninitializeSampleAllocator();allocatorInitialized=false;}
        return events->QueueEventParamVar(MEStreamStopped,GUID_NULL,S_OK,nullptr);
    }
    HRESULT Shutdown() {
        { std::lock_guard<std::mutex> lock(mutex); if(shutdown)return S_OK; shutdown=true;running=false;generation++;requests.clear();if(events)events->Shutdown();wake.notify_all(); }
        if(worker.joinable())worker.join();
        std::lock_guard<std::mutex> lock(mutex);
        frames.Close(); if(allocatorInitialized)allocator->UninitializeSampleAllocator(); allocatorInitialized=false;
        parent.Reset(); allocator.Reset(); descriptor.Reset(); attributes.Reset(); events.Reset(); return S_OK;
    }
    HRESULT SetAllocator(IUnknown* value) {
        std::lock_guard<std::mutex> lock(mutex); if(shutdown)return MF_E_SHUTDOWN;
        if(running)return MF_E_INVALID_STATE_TRANSITION;
        if(!value){allocator.Reset();return S_OK;} return value->QueryInterface(IID_PPV_ARGS(&allocator));
    }
    HRESULT Attributes(IMFAttributes** out) { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:attributes.CopyTo(out); }
    STDMETHODIMP GetMediaSource(IMFMediaSource** out) override { std::lock_guard<std::mutex> lock(mutex); return shutdown?MF_E_SHUTDOWN:parent.CopyTo(out); }
    STDMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** out) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:descriptor.CopyTo(out); }
    STDMETHODIMP RequestSample(IUnknown* token) override {
        std::lock_guard<std::mutex> lock(mutex); if(shutdown)return MF_E_SHUTDOWN;if(!running)return MF_E_INVALIDREQUEST;
        if(requests.size()>=8)return MF_E_NOTACCEPTING; requests.emplace_back(token);wake.notify_all();return S_OK;
    }
    STDMETHODIMP SetStreamState(MF_STREAM_STATE state) override {
        std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;
        if(state!=MF_STREAM_STATE_RUNNING&&state!=MF_STREAM_STATE_PAUSED&&state!=MF_STREAM_STATE_STOPPED)return E_INVALIDARG;
        streamState=state;running=state==MF_STREAM_STATE_RUNNING;generation++;if(!running)requests.clear();wake.notify_all();return S_OK;
    }
    STDMETHODIMP GetStreamState(MF_STREAM_STATE* out) override { if(!out)return E_POINTER;std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;*out=streamState;return S_OK; }
    STDMETHODIMP GetEvent(DWORD flags,IMFMediaEvent** out) override { ComPtr<IMFMediaEventQueue> queue;{std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;queue=events;}return queue->GetEvent(flags,out); }
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback,IUnknown* state) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->BeginGetEvent(callback,state); }
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result,IMFMediaEvent** out) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->EndGetEvent(result,out); }
    STDMETHODIMP QueueEvent(MediaEventType type,REFGUID extended,HRESULT hr,const PROPVARIANT* value) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->QueueEventParamVar(type,extended,hr,value); }
};

class MediaSource final : public RuntimeClass<RuntimeClassFlags<ClassicCom>,
    ChainInterfaces<IMFMediaSourceEx,IMFMediaSource,IMFMediaEventGenerator>,IMFGetService,IKsControl,IMFSampleAllocatorControl,FtmBase> {
    std::mutex mutex;
    bool shutdown=false,started=false;
    ComPtr<IMFMediaEventQueue> events;
    ComPtr<IMFAttributes> attributes;
    ComPtr<IMFPresentationDescriptor> presentation;
    ComPtr<MediaStream> stream;
public:
    ~MediaSource(){Shutdown();}
    HRESULT Initialize(IMFAttributes* initial) {
        CHECK(MFCreateEventQueue(&events));CHECK(MFCreateAttributes(&attributes,16));
        if(initial)CHECK(initial->CopyAllItems(attributes.Get()));
        CHECK(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
        CHECK(attributes->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_CATEGORY,KSCATEGORY_VIDEO_CAMERA));
        CHECK(attributes->SetUINT32(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_HW_SOURCE,0));
        CHECK(attributes->SetString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,CameraName));
        wchar_t path[32768]{};
        if(FAILED(attributes->GetString(FramePathAttribute,path,32768,nullptr)))path[0]=0;
        stream=Make<MediaStream>();if(!stream)return E_OUTOFMEMORY;CHECK(stream->Initialize(this,path));
        ComPtr<IMFStreamDescriptor> descriptor;CHECK(stream->GetStreamDescriptor(&descriptor));
        IMFStreamDescriptor* raw=descriptor.Get();CHECK(MFCreatePresentationDescriptor(1,&raw,&presentation));
        return presentation->SelectStream(0);
    }
    STDMETHODIMP GetCharacteristics(DWORD* out) override { if(!out)return E_POINTER;std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;*out=MFMEDIASOURCE_IS_LIVE;return S_OK; }
    STDMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** out) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:presentation->Clone(out); }
    STDMETHODIMP Start(IMFPresentationDescriptor* descriptor,const GUID* timeFormat,const PROPVARIANT* position) override {
        std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;if(!descriptor||!position)return E_INVALIDARG;
        if(timeFormat&&*timeFormat!=GUID_NULL)return MF_E_UNSUPPORTED_TIME_FORMAT;
        if(position->vt!=VT_EMPTY&&position->vt!=VT_I8)return MF_E_UNSUPPORTED_TIME_FORMAT;
        DWORD count=0;CHECK(descriptor->GetStreamDescriptorCount(&count));if(count!=1)return E_INVALIDARG;
        BOOL selected=FALSE;ComPtr<IMFStreamDescriptor> sd;CHECK(descriptor->GetStreamDescriptorByIndex(0,&selected,&sd));
        DWORD id=1;CHECK(sd->GetStreamIdentifier(&id));if(id!=0||!selected)return E_INVALIDARG;
        ComPtr<IMFMediaTypeHandler> handler;ComPtr<IMFMediaType> type;CHECK(sd->GetMediaTypeHandler(&handler));CHECK(handler->GetCurrentMediaType(&type));
        CHECK(events->QueueEventParamUnk(started?MEUpdatedStream:MENewStream,GUID_NULL,S_OK,static_cast<IMFMediaStream2*>(stream.Get())));
        CHECK(stream->Start(type.Get()));CHECK(presentation->SelectStream(0));
        PROPVARIANT time{};InitPropVariantFromInt64(MFGetSystemTime(),&time);
        HRESULT hr=events->QueueEventParamVar(MESourceStarted,GUID_NULL,S_OK,&time);PropVariantClear(&time);if(SUCCEEDED(hr))started=true;return hr;
    }
    STDMETHODIMP Stop() override { std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;CHECK(stream->Stop());started=false;return events->QueueEventParamVar(MESourceStopped,GUID_NULL,S_OK,nullptr); }
    STDMETHODIMP Pause() override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:MF_E_INVALID_STATE_TRANSITION; }
    STDMETHODIMP Shutdown() override {
        ComPtr<MediaStream> closing;
        { std::lock_guard<std::mutex> lock(mutex);if(shutdown)return S_OK;shutdown=true;if(events)events->Shutdown();closing=stream;stream.Reset();presentation.Reset();attributes.Reset();events.Reset(); }
        if(closing)closing->Shutdown();return S_OK;
    }
    STDMETHODIMP GetSourceAttributes(IMFAttributes** out) override { std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:attributes.CopyTo(out); }
    STDMETHODIMP GetStreamAttributes(DWORD id,IMFAttributes** out) override { std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;return id==0?stream->Attributes(out):MF_E_INVALIDSTREAMNUMBER; }
    STDMETHODIMP SetD3DManager(IUnknown*) override { return E_NOTIMPL; }
    STDMETHODIMP GetService(REFGUID,REFIID,void** out) override {if(!out)return E_POINTER;*out=nullptr;return MF_E_UNSUPPORTED_SERVICE;}
    STDMETHODIMP KsProperty(PKSPROPERTY,ULONG,void*,ULONG,ULONG* bytes) override {if(bytes)*bytes=0;return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);}
    STDMETHODIMP KsMethod(PKSMETHOD,ULONG,void*,ULONG,ULONG* bytes) override {if(bytes)*bytes=0;return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);}
    STDMETHODIMP KsEvent(PKSEVENT,ULONG,void*,ULONG,ULONG* bytes) override {if(bytes)*bytes=0;return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);}
    STDMETHODIMP SetDefaultAllocator(DWORD id,IUnknown* allocator) override {std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;return id==0?stream->SetAllocator(allocator):MF_E_INVALIDSTREAMNUMBER;}
    STDMETHODIMP GetAllocatorUsage(DWORD id,DWORD* input,MFSampleAllocatorUsage* usage) override {if(!input||!usage)return E_POINTER;if(id!=0)return MF_E_INVALIDSTREAMNUMBER;*input=0;*usage=MFSampleAllocatorUsage_UsesProvidedAllocator;return S_OK;}
    STDMETHODIMP GetEvent(DWORD flags,IMFMediaEvent** out) override {ComPtr<IMFMediaEventQueue> queue;{std::lock_guard<std::mutex> lock(mutex);if(shutdown)return MF_E_SHUTDOWN;queue=events;}return queue->GetEvent(flags,out);}
    STDMETHODIMP BeginGetEvent(IMFAsyncCallback* callback,IUnknown* state) override {std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->BeginGetEvent(callback,state);}
    STDMETHODIMP EndGetEvent(IMFAsyncResult* result,IMFMediaEvent** out) override {std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->EndGetEvent(result,out);}
    STDMETHODIMP QueueEvent(MediaEventType type,REFGUID extended,HRESULT hr,const PROPVARIANT* value) override {std::lock_guard<std::mutex> lock(mutex);return shutdown?MF_E_SHUTDOWN:events->QueueEventParamVar(type,extended,hr,value);}
};

// IMFActivate carries Frame Server attributes into the media source at activation.
class Activate final : public RuntimeClass<RuntimeClassFlags<ClassicCom>,ChainInterfaces<IMFActivate,IMFAttributes>,FtmBase> {
    ComPtr<IMFAttributes> attributes;
    ComPtr<MediaSource> source;
    std::mutex mutex;
public:
    ~Activate(){ShutdownObject();}
    HRESULT Initialize(){return MFCreateAttributes(&attributes,16);}
    STDMETHODIMP ActivateObject(REFIID iid,void** out) override {std::lock_guard<std::mutex> lock(mutex);if(!out)return E_POINTER;*out=nullptr;if(!source){source=Make<MediaSource>();if(!source)return E_OUTOFMEMORY;HRESULT hr=source->Initialize(attributes.Get());if(FAILED(hr)){source->Shutdown();source.Reset();return hr;}}return source->QueryInterface(iid,out);}
    STDMETHODIMP ShutdownObject() override {std::lock_guard<std::mutex> lock(mutex);if(source)source->Shutdown();source.Reset();return S_OK;}
    STDMETHODIMP DetachObject() override {std::lock_guard<std::mutex> lock(mutex);source.Reset();return S_OK;}
    STDMETHODIMP GetItem(REFGUID k,PROPVARIANT* v) override{return attributes->GetItem(k,v);}
    STDMETHODIMP GetItemType(REFGUID k,MF_ATTRIBUTE_TYPE* v) override{return attributes->GetItemType(k,v);}
    STDMETHODIMP CompareItem(REFGUID k,REFPROPVARIANT v,BOOL* r) override{return attributes->CompareItem(k,v,r);}
    STDMETHODIMP Compare(IMFAttributes* o,MF_ATTRIBUTES_MATCH_TYPE m,BOOL* r) override{return attributes->Compare(o,m,r);}
    STDMETHODIMP GetUINT32(REFGUID k,UINT32* v) override{return attributes->GetUINT32(k,v);}
    STDMETHODIMP GetUINT64(REFGUID k,UINT64* v) override{return attributes->GetUINT64(k,v);}
    STDMETHODIMP GetDouble(REFGUID k,double* v) override{return attributes->GetDouble(k,v);}
    STDMETHODIMP GetGUID(REFGUID k,GUID* v) override{return attributes->GetGUID(k,v);}
    STDMETHODIMP GetStringLength(REFGUID k,UINT32* v) override{return attributes->GetStringLength(k,v);}
    STDMETHODIMP GetString(REFGUID k,LPWSTR v,UINT32 n,UINT32* r) override{return attributes->GetString(k,v,n,r);}
    STDMETHODIMP GetAllocatedString(REFGUID k,LPWSTR* v,UINT32* n) override{return attributes->GetAllocatedString(k,v,n);}
    STDMETHODIMP GetBlobSize(REFGUID k,UINT32* v) override{return attributes->GetBlobSize(k,v);}
    STDMETHODIMP GetBlob(REFGUID k,UINT8* v,UINT32 n,UINT32* r) override{return attributes->GetBlob(k,v,n,r);}
    STDMETHODIMP GetAllocatedBlob(REFGUID k,UINT8** v,UINT32* n) override{return attributes->GetAllocatedBlob(k,v,n);}
    STDMETHODIMP GetUnknown(REFGUID k,REFIID i,void** v) override{return attributes->GetUnknown(k,i,v);}
    STDMETHODIMP SetItem(REFGUID k,REFPROPVARIANT v) override{return attributes->SetItem(k,v);}
    STDMETHODIMP DeleteItem(REFGUID k) override{return attributes->DeleteItem(k);}
    STDMETHODIMP DeleteAllItems() override{return attributes->DeleteAllItems();}
    STDMETHODIMP SetUINT32(REFGUID k,UINT32 v) override{return attributes->SetUINT32(k,v);}
    STDMETHODIMP SetUINT64(REFGUID k,UINT64 v) override{return attributes->SetUINT64(k,v);}
    STDMETHODIMP SetDouble(REFGUID k,double v) override{return attributes->SetDouble(k,v);}
    STDMETHODIMP SetGUID(REFGUID k,REFGUID v) override{return attributes->SetGUID(k,v);}
    STDMETHODIMP SetString(REFGUID k,LPCWSTR v) override{return attributes->SetString(k,v);}
    STDMETHODIMP SetBlob(REFGUID k,const UINT8* v,UINT32 n) override{return attributes->SetBlob(k,v,n);}
    STDMETHODIMP SetUnknown(REFGUID k,IUnknown* v) override{return attributes->SetUnknown(k,v);}
    STDMETHODIMP LockStore() override{return attributes->LockStore();}
    STDMETHODIMP UnlockStore() override{return attributes->UnlockStore();}
    STDMETHODIMP GetCount(UINT32* v) override{return attributes->GetCount(v);}
    STDMETHODIMP GetItemByIndex(UINT32 n,GUID* k,PROPVARIANT* v) override{return attributes->GetItemByIndex(n,k,v);}
    STDMETHODIMP CopyAllItems(IMFAttributes* v) override{return attributes->CopyAllItems(v);}
};

class Factory final : public RuntimeClass<RuntimeClassFlags<ClassicCom>,IClassFactory> {
public:
    STDMETHODIMP CreateInstance(IUnknown* outer,REFIID iid,void** out) override {if(!out)return E_POINTER;*out=nullptr;if(outer)return CLASS_E_NOAGGREGATION;auto activation=Make<Activate>();if(!activation)return E_OUTOFMEMORY;CHECK(activation->Initialize());return activation->QueryInterface(iid,out);}
    STDMETHODIMP LockServer(BOOL) override{return S_OK;}
};
extern "C" HRESULT WINAPI DllGetClassObject(REFCLSID clsid,REFIID iid,void** out) {if(!out)return E_POINTER;*out=nullptr;if(clsid!=CameraSourceClsid)return CLASS_E_CLASSNOTAVAILABLE;auto factory=Make<Factory>();return factory?factory->QueryInterface(iid,out):E_OUTOFMEMORY;}
// Keep code loaded while Frame Server may retain asynchronous callbacks.
extern "C" HRESULT WINAPI DllCanUnloadNow(){return S_FALSE;}

// Producer-side exports keep publication ordering explicit across processes.
extern "C" HRESULT WINAPI RMCWriteFrame(void* destination,UINT32 width,UINT32 height,UINT32 fps,const BYTE* pixels,UINT32 bytes){
    if(!destination||!pixels)return E_POINTER;
    if(width<2||height<2||width>MaxWidth||height>MaxHeight||(width&1)||(height&1)||fps<5||fps>30||bytes!=width*height*3/2)return E_INVALIDARG;
    auto header=static_cast<FrameHeader*>(destination);
    InterlockedIncrement(&header->sequence);
    header->magic=FrameMagic;header->version=FrameVersion;header->width=width;header->height=height;header->fps=fps;header->bytes=bytes;
    memcpy(static_cast<BYTE*>(destination)+sizeof(FrameHeader),pixels,bytes);
    header->tickMs=GetTickCount64();header->generation++;header->active=1;
    MemoryBarrier();InterlockedIncrement(&header->sequence);return S_OK;
}
extern "C" HRESULT WINAPI RMCClearFrame(void* destination){
    if(!destination)return E_POINTER;auto header=static_cast<FrameHeader*>(destination);
    // A terminated producer may leave an odd sequence. Keep it odd during
    // clearing, then publish an even sequence so the next producer can recover.
    if(header->sequence&1)InterlockedAdd(&header->sequence,2);else InterlockedIncrement(&header->sequence);
    header->active=0;header->bytes=0;header->tickMs=GetTickCount64();
    SecureZeroMemory(static_cast<BYTE*>(destination)+sizeof(FrameHeader),MaxFrameBytes);
    MemoryBarrier();InterlockedIncrement(&header->sequence);return S_OK;
}
