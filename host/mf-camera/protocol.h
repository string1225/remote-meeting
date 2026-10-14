#pragma once
#define NOMINMAX
#include <windows.h>
#include <cstdint>
#include <cstddef>

// One latest NV12 frame. The writer owns pixels; Frame Server only reads.
inline constexpr uint32_t FrameMagic = 0x524d4341;
inline constexpr uint32_t FrameVersion = 1;
inline constexpr uint32_t MaxWidth = 1920, MaxHeight = 1080;
inline constexpr size_t MaxFrameBytes = MaxWidth * MaxHeight * 3 / 2;
struct FrameHeader {
    uint32_t magic, version;
    volatile LONG sequence;
    uint32_t width, height, fps, active, bytes;
    uint64_t tickMs, generation;
    uint32_t reserved[4];
};
static_assert(sizeof(FrameHeader) == 64);
static_assert(offsetof(FrameHeader, sequence) == 8);
inline constexpr size_t MappingBytes = sizeof(FrameHeader) + MaxFrameBytes;
inline constexpr GUID CameraSourceClsid = {0x4f22ddb6,0xc706,0x4dc9,{0xae,0x89,0x7c,0x9d,0x29,0xb6,0x62,0x41}};
inline constexpr GUID FramePathAttribute = {0x65f6f2da,0x4942,0x4940,{0xb1,0x99,0x2c,0x36,0xe3,0xf7,0x86,0x8d}};
inline constexpr wchar_t CameraSourceId[] = L"{4F22DDB6-C706-4DC9-AE89-7C9D29B66241}";
inline constexpr wchar_t CameraName[] = L"Remote Meeting Camera";
inline constexpr wchar_t ConfigKey[] = L"SOFTWARE\\RemoteMeetingCamera";
