fn main() {
    // NDI Advanced SDK for Apple — link the dynamic library
    let ndi_lib_path = "/Library/NDI Advanced SDK for Apple/lib/macOS";
    println!("cargo:rustc-link-search=native={}", ndi_lib_path);
    println!("cargo:rustc-link-lib=dylib=ndi_advanced");
    
    // Set rpath so the runtime linker can find the dylib
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", ndi_lib_path);

    tauri_build::build()
}
