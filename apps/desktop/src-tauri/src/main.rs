// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    // Card-builder helper mode: the app re-runs itself (unprivileged for image
    // files, elevated for physical cards) instead of shipping a separate binary.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--sdcard-helper") {
        return tmp_sdcard::cli::main(resolve_device_dir(args.collect()));
    }
    tmp_nam_companion_lib::run();
    std::process::ExitCode::SUCCESS
}

/// An AppImage's root helper runs from its own extraction and gets `--device-dir`
/// relative to the AppImage root (`sdcard::elevated_command`): resolve it against
/// the APPDIR the AppImage runtime sets.
fn resolve_device_dir(mut args: Vec<String>) -> Vec<String> {
    let Some(appdir) = std::env::var_os("APPDIR") else {
        return args;
    };
    if let Some(dir) = args
        .iter()
        .position(|a| a == "--device-dir")
        .and_then(|i| args.get_mut(i + 1))
        .filter(|d| std::path::Path::new(d.as_str()).is_relative())
    {
        *dir = std::path::Path::new(&appdir)
            .join(dir.as_str())
            .to_string_lossy()
            .into_owned();
    }
    args
}
