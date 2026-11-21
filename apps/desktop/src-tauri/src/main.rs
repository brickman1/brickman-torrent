// The desktop app is a GUI program: without this attribute Windows attaches a
// console window to the release build (debug builds keep it for logs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    brickman_desktop_lib::run()
}
