#include "protocol.h"
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>
#include <mferror.h>
#include <wrl.h>
#include <propvarutil.h>
#include <string>
#include <iostream>
#include <vector>
#include <cstdio>

using namespace Microsoft::WRL;
#define CHECK(call) do { HRESULT rmcResult = (call); if (FAILED(rmcResult)) return rmcResult; } while (0)
static std::string Utf8(const std::wstring& text){if(text.empty())return {};int n=WideCharToMultiByte(CP_UTF8,0,text.data(),int(text.size()),nullptr,0,nullptr,nullptr);std::string result(n,0);WideCharToMultiByte(CP_UTF8,0,text.data(),int(text.size()),result.data(),n,nullptr,nullptr);return result;}
static std::string Json(const std::wstring& text){auto input=Utf8(text);std::string out="\"";for(unsigned char c:input){if(c=='\\'||c=='\"'){out+='\\';out+=c;}else if(c<32){char value[7];sprintf_s(value,"\\u%04x",c);out+=value;}else out+=c;}return out+'\"';}
static std::wstring Attribute(IMFAttributes* attrs,REFGUID key){LPWSTR text=nullptr;UINT32 n=0;if(FAILED(attrs->GetAllocatedString(key,&text,&n)))return {};std::wstring result(text,n);CoTaskMemFree(text);return result;}

static HRESULT Devices(bool onlyOwn,std::wstring* foundName=nullptr){
    ComPtr<IMFAttributes> attrs;CHECK(MFCreateAttributes(&attrs,1));CHECK(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID));
    IMFActivate** devices=nullptr;UINT32 count=0;CHECK(MFEnumDeviceSources(attrs.Get(),&devices,&count));
    bool first=true;std::cout<<"{\"devices\":[";
    for(UINT32 i=0;i<count;i++){
        auto name=Attribute(devices[i],MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
        bool own=name.rfind(CameraName,0)==0;
        if(own&&foundName)*foundName=name;
        if(!onlyOwn||own){if(!first)std::cout<<',';first=false;std::cout<<"{\"name\":"<<Json(name)<<",\"native\":"<<(own?"true":"false")<<'}';}
        devices[i]->Release();
    }
    CoTaskMemFree(devices);std::cout<<"]}"<<std::endl;return S_OK;
}

static HRESULT Publish(bool remove){
    BOOL supported=FALSE;CHECK(MFIsVirtualCameraTypeSupported(MFVirtualCameraType_SoftwareCameraSource,&supported));if(!supported)return HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED);
    ComPtr<IMFVirtualCamera> camera;
    CHECK(MFCreateVirtualCamera(MFVirtualCameraType_SoftwareCameraSource,MFVirtualCameraLifetime_System,MFVirtualCameraAccess_CurrentUser,CameraName,CameraSourceId,nullptr,0,&camera));
    if(remove){CHECK(camera->Remove());std::cout<<"{\"removed\":true}"<<std::endl;return S_OK;}
    // System lifetime keeps the device enumerable while the host releases physical inputs.
    CHECK(camera->Start(nullptr));
    std::wstring name;CHECK(Devices(true,&name));if(name.empty())return HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
    return S_OK;
}

static HRESULT SelfTest(LPCWSTR dll,LPCWSTR framePath){
    HMODULE module=LoadLibraryW(dll);if(!module)return HRESULT_FROM_WIN32(GetLastError());
    auto getClass=reinterpret_cast<HRESULT(WINAPI*)(REFCLSID,REFIID,void**)>(GetProcAddress(module,"DllGetClassObject"));if(!getClass)return E_NOINTERFACE;
    ComPtr<IClassFactory> factory;CHECK(getClass(CameraSourceClsid,IID_PPV_ARGS(&factory)));
    ComPtr<IMFActivate> activation;CHECK(factory->CreateInstance(nullptr,IID_PPV_ARGS(&activation)));
    if(framePath)CHECK(activation->SetString(FramePathAttribute,framePath));
    ComPtr<IMFMediaSourceEx> source;CHECK(activation->ActivateObject(IID_PPV_ARGS(&source)));
    ComPtr<IMFAttributes> attributes;CHECK(source->GetSourceAttributes(&attributes));
    ComPtr<IMFGetService> service;CHECK(source.As(&service));
    ComPtr<IMFSampleAllocatorControl> control;CHECK(source.As(&control));
    DWORD input=999;MFSampleAllocatorUsage usage{};CHECK(control->GetAllocatorUsage(0,&input,&usage));if(input!=0||usage!=MFSampleAllocatorUsage_UsesProvidedAllocator)return E_FAIL;
    ComPtr<IMFPresentationDescriptor> presentation;CHECK(source->CreatePresentationDescriptor(&presentation));
    BOOL selected=FALSE;ComPtr<IMFStreamDescriptor> descriptor;CHECK(presentation->GetStreamDescriptorByIndex(0,&selected,&descriptor));if(!selected)return E_FAIL;
    ComPtr<IMFMediaTypeHandler> handler;CHECK(descriptor->GetMediaTypeHandler(&handler));
    DWORD types=0;CHECK(handler->GetMediaTypeCount(&types));if(types!=6)return E_FAIL;
    for(DWORD typeIndex=0;typeIndex<types;typeIndex++){
        ComPtr<IMFMediaType> type;CHECK(handler->GetMediaTypeByIndex(typeIndex,&type));CHECK(handler->SetCurrentMediaType(type.Get()));
        ComPtr<IMFVideoSampleAllocatorEx> allocator;CHECK(MFCreateVideoSampleAllocatorEx(IID_PPV_ARGS(&allocator)));CHECK(control->SetDefaultAllocator(0,allocator.Get()));
        PROPVARIANT position{};CHECK(source->Start(presentation.Get(),nullptr,&position));
        ComPtr<IMFMediaEvent> event;CHECK(source->GetEvent(0,&event));MediaEventType eventType{};CHECK(event->GetType(&eventType));if(eventType!=MENewStream)return E_FAIL;
        PROPVARIANT value{};CHECK(event->GetValue(&value));if(value.vt!=VT_UNKNOWN)return E_FAIL;
        ComPtr<IMFMediaStream2> stream;HRESULT hr=value.punkVal->QueryInterface(IID_PPV_ARGS(&stream));PropVariantClear(&value);CHECK(hr);
        CHECK(stream->GetEvent(0,&event));CHECK(event->GetType(&eventType));if(eventType!=MEStreamStarted)return E_FAIL;
        CHECK(stream->RequestSample(nullptr));CHECK(stream->GetEvent(0,&event));CHECK(event->GetType(&eventType));if(eventType!=MEMediaSample){event->GetStatus(&hr);return FAILED(hr)?hr:E_FAIL;}
        CHECK(event->GetValue(&value));ComPtr<IMFSample> sample;hr=value.punkVal->QueryInterface(IID_PPV_ARGS(&sample));PropVariantClear(&value);CHECK(hr);
        ComPtr<IMFMediaBuffer> buffer;CHECK(sample->ConvertToContiguousBuffer(&buffer));DWORD length=0;CHECK(buffer->GetCurrentLength(&length));
        UINT32 w=0,h=0;GUID subtype{};CHECK(MFGetAttributeSize(type.Get(),MF_MT_FRAME_SIZE,&w,&h));CHECK(type->GetGUID(MF_MT_SUBTYPE,&subtype));
        if(length<w*h*(subtype==MFVideoFormat_NV12?3:4)/2)return E_FAIL;
        BYTE* bytes=nullptr;CHECK(buffer->Lock(&bytes,nullptr,nullptr));
        std::cout<<"{\"sample\":true,\"width\":"<<w<<",\"height\":"<<h<<",\"format\":\""<<(subtype==MFVideoFormat_NV12?"NV12":"YUY2")<<"\",\"luma\":"<<unsigned(bytes[0])<<"}"<<std::endl;
        CHECK(buffer->Unlock());sample.Reset();event.Reset();buffer.Reset();
        CHECK(source->Stop());
        // Drain source events (source started, then source stopped).
        while(SUCCEEDED(source->GetEvent(MF_EVENT_FLAG_NO_WAIT,&event)))event.Reset();
        while(SUCCEEDED(stream->GetEvent(MF_EVENT_FLAG_NO_WAIT,&event)))event.Reset();
        MF_STREAM_STATE state{};CHECK(stream->GetStreamState(&state));if(state!=MF_STREAM_STATE_STOPPED)return E_FAIL;
        stream.Reset();
    }
    CHECK(source->Shutdown());CHECK(activation->ShutdownObject());
    std::cout<<"{\"selfTest\":true,\"mediaTypes\":6}"<<std::endl;return S_OK;
}

static HRESULT Run(int argc,wchar_t** argv){
    if(argc<2)return E_INVALIDARG;
    std::wstring action=argv[1];
    if(action==L"publish")return Publish(false);
    if(action==L"remove")return Publish(true);
    if(action==L"list")return Devices(false);
    if(action==L"status")return Devices(true);
    if(action==L"self-test"&&argc>=3)return SelfTest(argv[2],argc>=4?argv[3]:nullptr);
    return E_INVALIDARG;
}
int wmain(int argc,wchar_t** argv){
    SetConsoleOutputCP(CP_UTF8);HRESULT hr=CoInitializeEx(nullptr,COINIT_MULTITHREADED);bool com=SUCCEEDED(hr);
    if(SUCCEEDED(hr))hr=MFStartup(MF_VERSION);bool mf=SUCCEEDED(hr);
    if(SUCCEEDED(hr)){try{hr=Run(argc,argv);}catch(...){hr=E_OUTOFMEMORY;}}
    if(FAILED(hr)){char code[12];sprintf_s(code,"0x%08lx",static_cast<unsigned long>(hr));std::cout<<"{\"error\":\""<<code<<"\"}"<<std::endl;}
    if(mf)MFShutdown();if(com)CoUninitialize();return FAILED(hr)?1:0;
}
