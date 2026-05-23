// NDI FFI bindings — minimal subset for Send API with RGBA alpha support.
// Links against libndi_advanced.dylib from "/Library/NDI Advanced SDK for Apple/lib/macOS/"

#![allow(non_camel_case_types, non_upper_case_globals, dead_code)]

use std::os::raw::{c_char, c_int, c_float};
use std::ffi::CString;
use std::ptr;
use std::sync::Mutex;

// Opaque handle type returned by NDIlib_send_create
pub type NDIlib_send_instance_t = *mut std::os::raw::c_void;

// FourCC RGBA = 'R' | ('G' << 8) | ('B' << 16) | ('A' << 24)
pub const FOURCC_RGBA: u32 = 0x41424752; // little-endian: R=0x52, G=0x47, B=0x42, A=0x41

// Frame format progressive
pub const FRAME_FORMAT_PROGRESSIVE: u32 = 1;

// Timecode synthesize
pub const TIMECODE_SYNTHESIZE: i64 = i64::MAX;

#[repr(C)]
pub struct NDIlib_send_create_t {
    pub p_ndi_name: *const c_char,
    pub p_groups: *const c_char,
    pub clock_video: bool,
    pub clock_audio: bool,
}

#[repr(C)]
pub struct NDIlib_video_frame_v2_t {
    pub xres: c_int,
    pub yres: c_int,
    pub four_cc: u32,
    pub frame_rate_n: c_int,
    pub frame_rate_d: c_int,
    pub picture_aspect_ratio: c_float,
    pub frame_format_type: u32,
    pub timecode: i64,
    pub p_data: *mut u8,
    pub line_stride_in_bytes: c_int,
    pub p_metadata: *const c_char,
    pub timestamp: i64,
}

extern "C" {
    pub fn NDIlib_initialize() -> bool;
    pub fn NDIlib_destroy();
    pub fn NDIlib_send_create(p_create_settings: *const NDIlib_send_create_t) -> NDIlib_send_instance_t;
    pub fn NDIlib_send_destroy(p_instance: NDIlib_send_instance_t);
    pub fn NDIlib_send_send_video_v2(p_instance: NDIlib_send_instance_t, p_video_data: *const NDIlib_video_frame_v2_t);
}

/// High-level NDI Sender wrapper with safe lifecycle management.
pub struct NdiSender {
    instance: NDIlib_send_instance_t,
    _name: CString, // prevent deallocation while NDI holds the pointer
    pub width: u32,
    pub height: u32,
    pub frame_rate: u32,
}

unsafe impl Send for NdiSender {}
unsafe impl Sync for NdiSender {}

impl NdiSender {
    pub fn new(name: &str, width: u32, height: u32, frame_rate: u32) -> Result<Self, String> {
        unsafe {
            if !NDIlib_initialize() {
                return Err("NDIlib_initialize failed. Is NDI runtime installed?".to_string());
            }
        }

        let c_name = CString::new(name).map_err(|e| format!("Invalid NDI name: {}", e))?;

        let create_settings = NDIlib_send_create_t {
            p_ndi_name: c_name.as_ptr(),
            p_groups: ptr::null(),
            clock_video: false,
            clock_audio: false,
        };

        let instance = unsafe { NDIlib_send_create(&create_settings) };
        if instance.is_null() {
            return Err("NDIlib_send_create returned null".to_string());
        }

        Ok(NdiSender {
            instance,
            _name: c_name,
            width,
            height,
            frame_rate,
        })
    }

    /// Send one RGBA frame. The buffer must be exactly width*height*4 bytes.
    pub fn send_frame(&self, rgba_data: &mut [u8]) -> Result<(), String> {
        if rgba_data.len() != (self.width * self.height * 4) as usize {
            return Err(format!(
                "Buffer size mismatch: expected {} got {}",
                self.width * self.height * 4,
                rgba_data.len()
            ));
        }

        let video_frame = NDIlib_video_frame_v2_t {
            xres: self.width as c_int,
            yres: self.height as c_int,
            four_cc: FOURCC_RGBA,
            frame_rate_n: self.frame_rate as c_int * 1000,
            frame_rate_d: 1000,
            picture_aspect_ratio: 0.0,
            frame_format_type: FRAME_FORMAT_PROGRESSIVE,
            timecode: TIMECODE_SYNTHESIZE,
            p_data: rgba_data.as_mut_ptr(),
            line_stride_in_bytes: (self.width * 4) as c_int,
            p_metadata: ptr::null(),
            timestamp: 0,
        };

        unsafe {
            NDIlib_send_send_video_v2(self.instance, &video_frame);
        }

        Ok(())
    }
}

impl Drop for NdiSender {
    fn drop(&mut self) {
        unsafe {
            NDIlib_send_destroy(self.instance);
            NDIlib_destroy();
        }
    }
}

// Global sender state protected by Mutex
pub static NDI_SENDER: Mutex<Option<NdiSender>> = Mutex::new(None);

