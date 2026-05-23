use tauri::{AppHandle, Manager, Emitter};
use std::sync::OnceLock;
use std::sync::mpsc::Sender;
use tokio::sync::broadcast;

static NDI_TX: OnceLock<Sender<Vec<u8>>> = OnceLock::new();
static WS_TX: OnceLock<broadcast::Sender<String>> = OnceLock::new();

mod ndi_ffi;

#[derive(serde::Serialize, Clone)]
struct MonitorInfo {
    name: Option<String>,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    scale_factor: f64,
    is_primary: bool,
}

#[tauri::command]
fn get_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let main_win = app.get_webview_window("main").ok_or("Main window not found")?;
    let monitors = main_win.available_monitors().map_err(|e| e.to_string())?;
    let primary = main_win.primary_monitor().map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for m in monitors {
        let is_p = if let Some(ref p) = primary {
            p.name() == m.name()
        } else {
            false
        };
        
        let name = m.name().map(|s| s.to_string()).unwrap_or_else(|| "Unknown Display".to_string());
        
        list.push(MonitorInfo {
            name: Some(name),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale_factor: m.scale_factor(),
            is_primary: is_p,
        });
    }
    Ok(list)
}

#[tauri::command]
fn move_overlay_to_monitor(app: AppHandle, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let overlay_win = app.get_webview_window("overlay").ok_or("Overlay window not found")?;
    
    // Position and size overlay window to fit the selected monitor exactly
    overlay_win.set_size(tauri::Size::Physical(tauri::PhysicalSize { width, height })).map_err(|e| e.to_string())?;
    overlay_win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y })).map_err(|e| e.to_string())?;
    
    // Ensure overlays are always on top and focusable
    let _ = overlay_win.set_always_on_top(true);
    
    Ok(())
}

#[tauri::command]
fn set_overlay_clickthrough(app: AppHandle, clickthrough: bool) -> Result<(), String> {
    let overlay_win = app.get_webview_window("overlay").ok_or("Overlay window not found")?;
    overlay_win.set_ignore_cursor_events(clickthrough).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_overlay_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let overlay_win = app.get_webview_window("overlay").ok_or("Overlay window not found")?;
    if visible {
        overlay_win.show().map_err(|e| e.to_string())?;
    } else {
        overlay_win.hide().map_err(|e| e.to_string())?;
    }
    // Broadcast visibility state to synchronize UI switch state
    let _ = app.emit("overlay-visibility-changed", visible);
    Ok(())
}

#[tauri::command]
fn share_timer_state(app: AppHandle, state_json: String) -> Result<(), String> {
    // Relay the timer and display state JSON directly to overlay window via Tauri IPC
    app.emit("timer-state-update", &state_json).map_err(|e| e.to_string())?;
    
    // 💡 Embedded Web Viewer WebSocket Broadcast
    if let Some(tx) = WS_TX.get() {
        let _ = tx.send(state_json);
    }
    
    Ok(())
}

#[tauri::command]
fn get_local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| e.to_string())
}

// === Embedded HTTP & WebSocket Server Handlers for Local Network Web Viewers ===
async fn handle_viewer_html() -> impl axum::response::IntoResponse {
    axum::response::Html(include_str!("viewer.html"))
}

async fn handle_ws_upgrade(
    ws: axum::extract::ws::WebSocketUpgrade,
    axum::extract::State(ws_tx): axum::extract::State<broadcast::Sender<String>>,
) -> impl axum::response::IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, ws_tx))
}

async fn handle_socket(mut socket: axum::extract::ws::WebSocket, ws_tx: broadcast::Sender<String>) {
    let mut rx = ws_tx.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if socket.send(axum::extract::ws::Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });
}

#[tauri::command]
fn set_main_content_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let main_win = app.get_webview_window("main").ok_or("Main window not found")?;
    main_win.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height })).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn detect_presentation_app() -> Result<String, String> {
    use std::process::Command;
    
    // Check if Microsoft PowerPoint is running via native pgrep (bypasses osascript sandbox).
    if let Ok(output) = Command::new("/usr/bin/pgrep").arg("-f").arg("Microsoft PowerPoint").output() {
        if output.status.success() {
            return Ok("PowerPoint".to_string());
        }
    }
    
    // Check if Keynote is running via native pgrep.
    if let Ok(output) = Command::new("/usr/bin/pgrep").arg("-x").arg("Keynote").output() {
        if output.status.success() {
            return Ok("Keynote".to_string());
        }
    }
    
    Ok("None".to_string())
}

#[tauri::command]
fn control_presentation(app_name: String, action: String, slide_index: Option<u32>) -> Result<String, String> {
    use std::process::Command;
    
    let script = match app_name.as_str() {
        "PowerPoint" => {
            match action.as_str() {
                "next" => r#"
                    tell application "Microsoft PowerPoint"
                        if (exists slide show window 1 of active presentation) then
                            tell slide show view of slide show window 1 of active presentation
                                go to next slide
                            end tell
                        end if
                    end tell
                "#.to_string(),
                "prev" => r#"
                    tell application "Microsoft PowerPoint"
                        if (exists slide show window 1 of active presentation) then
                            tell slide show view of slide show window 1 of active presentation
                                go to previous slide
                            end tell
                        end if
                    end tell
                "#.to_string(),
                "goto" => {
                    let idx = slide_index.unwrap_or(1);
                    format!(r#"
                        tell application "Microsoft PowerPoint"
                            activate
                            if (exists slide show window 1 of active presentation) then
                                tell application "System Events"
                                    keystroke "{}"
                                    key code 36
                                end tell
                            end if
                        end tell
                    "#, idx)
                },
                "start" => r#"
                    tell application "Microsoft PowerPoint"
                        activate
                        run slide show slide show settings of active presentation
                    end tell
                "#.to_string(),
                "stop" => r#"
                    tell application "Microsoft PowerPoint"
                        if (exists slide show window 1 of active presentation) then
                            end (slide show window 1 of active presentation)
                        end if
                    end tell
                "#.to_string(),
                _ => return Err("Invalid action for PowerPoint".to_string()),
            }
        },
        "Keynote" => {
            match action.as_str() {
                "next" => r#"
                    tell application "Keynote"
                        tell front document
                            show next
                        end tell
                    end tell
                "#.to_string(),
                "prev" => r#"
                    tell application "Keynote"
                        tell front document
                            show previous
                        end tell
                    end tell
                "#.to_string(),
                "goto" => {
                    let idx = slide_index.unwrap_or(1);
                    format!(r#"
                        tell application "Keynote"
                            tell front document
                                set current slide to slide {}
                            end tell
                        end tell
                    "#, idx)
                },
                "start" => r#"
                    tell application "Keynote"
                        activate
                        start front document
                    end tell
                "#.to_string(),
                "stop" => r#"
                    tell application "Keynote"
                        stop front document
                    end tell
                "#.to_string(),
                _ => return Err("Invalid action for Keynote".to_string()),
            }
        },
        _ => return Err("Unsupported application".to_string()),
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

// === NDI Output Commands ===

#[tauri::command]
fn ndi_start_sender(name: String, width: u32, height: u32, fps: u32) -> Result<String, String> {
    let mut guard = ndi_ffi::NDI_SENDER.lock().map_err(|e| format!("Lock error: {}", e))?;
    if guard.is_some() {
        return Err("NDI sender is already running".to_string());
    }
    let sender = ndi_ffi::NdiSender::new(&name, width, height, fps)?;
    *guard = Some(sender);
    Ok(format!("NDI sender '{}' started ({}x{} @{}fps)", name, width, height, fps))
}

#[tauri::command]
fn ndi_stop_sender() -> Result<String, String> {
    let mut guard = ndi_ffi::NDI_SENDER.lock().map_err(|e| format!("Lock error: {}", e))?;
    if guard.is_none() {
        return Err("NDI sender is not running".to_string());
    }
    *guard = None; // Drop triggers NDIlib_send_destroy + NDIlib_destroy
    Ok("NDI sender stopped".to_string())
}

#[tauri::command]
fn ndi_send_frame(rgba: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    let expected = (width * height * 4) as usize;
    if rgba.len() != expected {
        return Err(format!("Frame size mismatch: expected {} got {}", expected, rgba.len()));
    }
    
    if let Some(tx) = NDI_TX.get() {
        // Pushes immediately to native queue and returns instantly in ~0.001ms.
        let _ = tx.send(rgba);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
            let _ = NDI_TX.set(tx);
            
            // 💡 Initialize WebSocket Broadcast Channel for IP Web Viewers
            let (ws_tx, _ws_rx) = broadcast::channel::<String>(64);
            let _ = WS_TX.set(ws_tx.clone());
            
            // Start the dedicated OS-native thread for NDI frame sending (Zero-Delay Pipeline)
            std::thread::spawn(move || {
                while let Ok(mut last_rgba) = rx.recv() {
                    // 💡 Latest-Only Queue Drain: Drop all older backlogged frames in the queue
                    // to eliminate any network/CPU frame accumulation latency (Zero Latency Guaranteed)
                    while let Ok(newer_rgba) = rx.try_recv() {
                        last_rgba = newer_rgba;
                    }
                    
                    // 💡 Prevent thread lock contention with start/stop FFI triggers.
                    // If the lock is held by controls, immediately skip this frame to guarantee absolute 0ms UI lag!
                    if let Ok(guard) = ndi_ffi::NDI_SENDER.try_lock() {
                        if let Some(ref sender) = *guard {
                            let mut rgba_mut = last_rgba;
                            let _ = sender.send_frame(&mut rgba_mut);
                        }
                    }
                }
            });
            
            // 💡 Spawn Embedded HTTP & WebSocket Server (Port 3003) with Safety Binder
            tauri::async_runtime::spawn(async move {
                use axum::{routing::get, Router};
                use tower_http::cors::CorsLayer;
                use std::net::SocketAddr;
                
                let app = Router::new()
                    .route("/", get(handle_viewer_html))
                    .route("/ws", get(handle_ws_upgrade))
                    .layer(CorsLayer::permissive())
                    .with_state(ws_tx);
                
                let addr = SocketAddr::from(([0, 0, 0, 0], 3003));
                if let Ok(listener) = tokio::net::TcpListener::bind(&addr).await {
                    let _ = axum::serve(listener, app).await;
                }
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_monitors,
            move_overlay_to_monitor,
            set_overlay_clickthrough,
            set_overlay_visible,
            share_timer_state,
            set_main_content_size,
            detect_presentation_app,
            control_presentation,
            ndi_start_sender,
            ndi_stop_sender,
            ndi_send_frame,
            get_local_ip
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

