fn main() {
    // Rebuild the Windows executable's resource table when only the shortcut icon changes.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
