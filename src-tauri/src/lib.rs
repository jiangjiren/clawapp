use base64::{engine::general_purpose, Engine as _};
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

/// 全局 git 互斥锁：保证同一时刻只有一个 git 子进程在 vault 上运行，
/// 防止 autostash/rebase 与其他 git 操作并发损坏仓库状态。
static GIT_LOCK: Mutex<()> = Mutex::new(());

const EXCLUDED_DIRECTORY_NAMES: &[&str] =
    &[".git", ".obsidian", ".claude", ".claudian", "node_modules"];

const NOTE_EXTENSIONS: &[&str] = &[
    "md", "html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg", "avif",
];

const TEXT_NOTE_EXTENSIONS: &[&str] = &["md", "html", "htm"];
const IMAGE_NOTE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"];
const MAX_PASTED_IMAGE_BYTES: usize = 20 * 1024 * 1024;

struct AppState {
    processes: Mutex<Vec<Child>>,
    agent_restart_lock: Mutex<()>,
    claude_port: u16,
    agent_token: String,
    sync_tx: Mutex<Option<mpsc::Sender<SyncJob>>>,
    vault_watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Deserialize)]
struct Config {
    vault_path: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum NoteTreeNode {
    Directory {
        name: String,
        path: String,
        children: Vec<NoteTreeNode>,
    },
    File {
        name: String,
        path: String,
        size: u64,
        #[serde(rename = "updatedAt")]
        updated_at: u64,
        extension: String,
    },
}

#[derive(Serialize)]
struct TreeResponse {
    root: NoteTreeNode,
    #[serde(rename = "generatedAt")]
    generated_at: u64,
}

#[derive(Serialize)]
struct NoteResponse {
    name: String,
    path: String,
    content: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    extension: String,
}

#[derive(Serialize)]
struct AssetResponse {
    name: String,
    path: String,
    #[serde(rename = "dataUrl")]
    data_url: String,
    mime: String,
    size: u64,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    extension: String,
}

#[derive(Debug, Serialize)]
struct PastedImageResponse {
    name: String,
    path: String,
}

#[derive(Serialize)]
struct DesktopState {
    #[serde(rename = "vaultPath")]
    vault_path: String,
    #[serde(rename = "agentUrl")]
    agent_url: String,
    #[serde(rename = "agentPort")]
    agent_port: u16,
    #[serde(rename = "agentReady")]
    agent_ready: bool,
    #[serde(rename = "agentToken")]
    agent_token: String,
}

#[derive(Clone, Serialize)]
struct VaultTreeChanged {
    #[serde(rename = "generatedAt")]
    generated_at: u64,
    #[serde(rename = "changedPaths")]
    changed_paths: Vec<String>,
}

#[derive(Clone, Serialize)]
struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
struct GitFileStatus {
    name: String,
    path: String,
    state: String,
    kind: String,
}

#[derive(Clone, Serialize)]
struct GitStatus {
    initialized: bool,
    clean: bool,
    branch: Option<String>,
    ahead: u32,
    behind: u32,
    entries: Vec<String>,
    files: Vec<GitFileStatus>,
    #[serde(rename = "lastSync")]
    last_sync: Option<String>,
    raw: String,
}

#[derive(Serialize)]
struct GitCommitRecord {
    hash: String,
    message: String,
    author: String,
    date: String,
}

#[derive(Serialize)]
struct GitDiffLine {
    #[serde(rename = "type")]
    line_type: String,
    content: String,
}

#[derive(Serialize)]
struct GitFileDiff {
    path: String,
    binary: bool,
    lines: Vec<GitDiffLine>,
    #[serde(rename = "addCount")]
    add_count: u32,
    #[serde(rename = "removeCount")]
    remove_count: u32,
}

#[derive(Serialize)]
struct SearchHit {
    path: String,
    name: String,
    snippet: String,
}

#[derive(Clone)]
struct ResolvedPath {
    absolute: PathBuf,
    relative: String,
}

fn unix_secs(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_secs()
}

fn now_secs() -> u64 {
    unix_secs(SystemTime::now())
}

fn is_excluded_segment(value: &str) -> bool {
    EXCLUDED_DIRECTORY_NAMES
        .iter()
        .any(|excluded| excluded.eq_ignore_ascii_case(value))
}

fn has_excluded_segment(relative_path: &str) -> bool {
    relative_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .any(is_excluded_segment)
}

fn path_extension(value: &Path) -> String {
    value
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_note_file(value: &Path) -> bool {
    let ext = path_extension(value);
    NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn is_tree_change_event(event: &NotifyEvent) -> bool {
    matches!(
        event.kind,
        notify::EventKind::Any
            | notify::EventKind::Create(_)
            | notify::EventKind::Modify(_)
            | notify::EventKind::Remove(_)
    )
}

fn is_vault_tree_event_path(root: &Path, path: &Path) -> bool {
    let relative = match path.strip_prefix(root) {
        Ok(value) => value,
        Err(_) => return false,
    };
    let relative_slash = to_slash_path(relative);
    if has_excluded_segment(&relative_slash) {
        return false;
    }
    let name = path.file_name().and_then(OsStr::to_str).unwrap_or("");
    if name.starts_with('.') && name != ".gitkeep" {
        return false;
    }
    if path.is_dir() {
        return true;
    }
    let ext = path_extension(path);
    if ext.is_empty() {
        return true;
    }
    NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn start_vault_watcher(app: &AppHandle) -> Result<(), String> {
    let root = vault_root(app)?;
    let root_for_filter = root.clone();
    let handle = app.clone();
    let mut watcher = RecommendedWatcher::new(
        move |result: Result<NotifyEvent, notify::Error>| {
            let Ok(event) = result else {
                return;
            };
            if !is_tree_change_event(&event) {
                return;
            }
            let changed_paths: Vec<String> = event
                .paths
                .iter()
                .filter(|path| is_vault_tree_event_path(&root_for_filter, path))
                .filter_map(|path| {
                    path.strip_prefix(&root_for_filter)
                        .ok()
                        .map(|rel| to_slash_path(rel))
                })
                .collect();
            if changed_paths.is_empty() {
                return;
            }
            let _ = handle.emit(
                "vault-tree-changed",
                VaultTreeChanged {
                    generated_at: now_secs(),
                    changed_paths,
                },
            );
        },
        NotifyConfig::default(),
    )
    .map_err(|err| err.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| err.to_string())?;

    let state = app.state::<AppState>();
    let mut slot = state.vault_watcher.lock().map_err(|err| err.to_string())?;
    *slot = Some(watcher);
    Ok(())
}

fn is_text_note(value: &Path) -> bool {
    let ext = path_extension(value);
    TEXT_NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn is_image_note(value: &Path) -> bool {
    let ext = path_extension(value);
    IMAGE_NOTE_EXTENSIONS.iter().any(|allowed| *allowed == ext)
}

fn mime_for_extension(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

fn pasted_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn has_bytes(data: &[u8], offset: usize, expected: &[u8]) -> bool {
    data.get(offset..offset.saturating_add(expected.len())) == Some(expected)
}

fn is_valid_pasted_image(mime_type: &str, data: &[u8]) -> bool {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/png" => has_bytes(data, 0, &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => has_bytes(data, 0, &[0xff, 0xd8, 0xff]),
        "image/gif" => has_bytes(data, 0, b"GIF87a") || has_bytes(data, 0, b"GIF89a"),
        "image/webp" => has_bytes(data, 0, b"RIFF") && has_bytes(data, 8, b"WEBP"),
        _ => false,
    }
}

fn pasted_image_base_name(original_name: &str) -> String {
    let raw_stem = Path::new(original_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("");
    let mut clean = raw_stem
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
            {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .chars()
        .take(96)
        .collect::<String>();

    if clean.is_empty() {
        clean = format!("image-{}", now_secs());
    }

    let lower = clean.to_ascii_lowercase();
    let windows_reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.as_bytes()[3].is_ascii_digit()
            && lower.as_bytes()[3] != b'0');
    if windows_reserved {
        format!("image-{clean}")
    } else {
        clean
    }
}

fn write_pasted_image_file(
    note_absolute: &Path,
    note_relative: &str,
    base_name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<PastedImageResponse, String> {
    let note_directory = note_absolute
        .parent()
        .ok_or_else(|| "Invalid note path.".to_string())?;
    let relative_directory = Path::new(note_relative)
        .parent()
        .unwrap_or_else(|| Path::new(""));

    for suffix in 1..=9_999 {
        let suffix_text = if suffix == 1 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let file_name = format!("{base_name}{suffix_text}.{extension}");
        let absolute = note_directory.join(&file_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&absolute)
        {
            Ok(mut file) => {
                if let Err(err) = file.write_all(bytes) {
                    drop(file);
                    let _ = fs::remove_file(&absolute);
                    return Err(err.to_string());
                }
                let path = to_slash_path(&relative_directory.join(&file_name));
                return Ok(PastedImageResponse {
                    name: file_name,
                    path,
                });
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.to_string()),
        }
    }

    Err("无法生成可用的图片文件名。".to_string())
}

fn to_slash_path(value: &Path) -> String {
    value
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_relative_path(input: &str, allow_empty: bool) -> Result<String, String> {
    let normalized_input = input.replace('\\', "/");
    let trimmed = normalized_input.trim().trim_start_matches('/');

    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err("Missing path.".to_string());
    }

    if trimmed.contains('\0') {
        return Err("Invalid path.".to_string());
    }

    let mut parts = Vec::new();
    for raw_segment in trimmed.split('/') {
        let segment = raw_segment.trim();
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err("Path traversal is not allowed.".to_string());
        }
        if is_excluded_segment(segment) {
            return Err("This path is excluded.".to_string());
        }
        parts.push(segment.to_string());
    }

    Ok(parts.join("/"))
}

fn relative_to_path_buf(relative_path: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for part in relative_path.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path
}

fn sanitize_name_segment(input: &str) -> Result<String, String> {
    let name = input.trim();
    if name.is_empty() {
        return Err("Missing name.".to_string());
    }
    if name.contains('\0') || name.contains('/') || name.contains('\\') {
        return Err("Invalid name.".to_string());
    }
    if name == "." || name == ".." || is_excluded_segment(name) {
        return Err("Invalid name.".to_string());
    }
    if name
        .chars()
        .any(|ch| matches!(ch, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return Err("Invalid name.".to_string());
    }
    Ok(name.to_string())
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let mut config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&config_dir);
    config_dir.push("config.json");
    config_dir
}

fn save_vault_path(app: &AppHandle, path: &Path) -> Result<(), String> {
    let config_path = get_config_path(app);
    let config = Config {
        vault_path: Some(path.to_string_lossy().to_string()),
    };
    let content = serde_json::to_string_pretty(&config).map_err(|err| err.to_string())?;
    fs::write(config_path, content).map_err(|err| err.to_string())
}

fn get_saved_vault_path(app: &AppHandle) -> Option<PathBuf> {
    let config_path = get_config_path(app);
    let content = fs::read_to_string(config_path).ok()?;
    let config = serde_json::from_str::<Config>(&content).ok()?;
    let path = PathBuf::from(config.vault_path?);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn default_vault_path(app: &AppHandle) -> PathBuf {
    app.path()
        .document_dir()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("inkfellow_notes")
}

fn ensure_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = get_saved_vault_path(app) {
        fs::create_dir_all(&path).map_err(|err| err.to_string())?;
        return Ok(path);
    }

    let path = default_vault_path(app);
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    save_vault_path(app, &path)?;
    Ok(path)
}

fn allow_vault_assets(app: &AppHandle, path: &Path) -> Result<(), String> {
    let canonical = fs::canonicalize(path).map_err(|err| err.to_string())?;
    app.asset_protocol_scope()
        .allow_directory(canonical, true)
        .map_err(|err| err.to_string())
}

fn vault_root(app: &AppHandle) -> Result<PathBuf, String> {
    let configured = ensure_vault_path(app)?;
    fs::canonicalize(configured).map_err(|_| "Vault path is unavailable.".to_string())
}

fn assert_inside_vault(path: &Path, root: &Path) -> Result<(), String> {
    if path == root || path.starts_with(root) {
        Ok(())
    } else {
        Err("Path traversal is not allowed.".to_string())
    }
}

fn resolve_existing_path(
    app: &AppHandle,
    relative_path: &str,
    allow_empty: bool,
) -> Result<ResolvedPath, String> {
    let root = vault_root(app)?;
    let relative = normalize_relative_path(relative_path, allow_empty)?;
    let candidate = if relative.is_empty() {
        root.clone()
    } else {
        root.join(relative_to_path_buf(&relative))
    };

    let canonical = fs::canonicalize(&candidate).map_err(|_| "File not found.".to_string())?;
    assert_inside_vault(&canonical, &root)?;

    let real_relative = canonical
        .strip_prefix(&root)
        .map(to_slash_path)
        .unwrap_or_else(|_| String::new());
    if has_excluded_segment(&real_relative) {
        return Err("This path is excluded.".to_string());
    }

    Ok(ResolvedPath {
        absolute: canonical,
        relative: real_relative,
    })
}

fn resolve_new_path(app: &AppHandle, relative_path: &str) -> Result<ResolvedPath, String> {
    let root = vault_root(app)?;
    let relative = normalize_relative_path(relative_path, false)?;
    let path = root.join(relative_to_path_buf(&relative));
    assert_inside_vault(&path, &root)?;

    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path.".to_string())?
        .to_path_buf();
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| "Parent folder not found.".to_string())?;
    assert_inside_vault(&canonical_parent, &root)?;

    Ok(ResolvedPath {
        absolute: path,
        relative,
    })
}

fn node_name_for_directory(root: &Path, absolute: &Path, relative_path: &str) -> String {
    if relative_path.is_empty() {
        return root
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("Vault")
            .to_string();
    }
    absolute
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("Folder")
        .to_string()
}

fn node_sort(left: &NoteTreeNode, right: &NoteTreeNode) -> Ordering {
    let left_is_file = matches!(left, NoteTreeNode::File { .. });
    let right_is_file = matches!(right, NoteTreeNode::File { .. });
    if left_is_file != right_is_file {
        return if left_is_file {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }

    let left_name = match left {
        NoteTreeNode::Directory { name, .. } => name,
        NoteTreeNode::File { name, .. } => name,
    };
    let right_name = match right {
        NoteTreeNode::Directory { name, .. } => name,
        NoteTreeNode::File { name, .. } => name,
    };
    left_name.to_lowercase().cmp(&right_name.to_lowercase())
}

fn walk_directory(
    root: &Path,
    absolute: &Path,
    relative_path: &str,
) -> Result<NoteTreeNode, String> {
    let mut children = Vec::new();
    let entries = fs::read_dir(absolute).map_err(|err| err.to_string())?;

    for entry_result in entries {
        let entry = entry_result.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        if has_excluded_segment(&child_relative) {
            continue;
        }

        let child_absolute = entry.path();
        if file_type.is_dir() {
            children.push(walk_directory(root, &child_absolute, &child_relative)?);
            continue;
        }

        if !file_type.is_file() || !is_note_file(&child_absolute) {
            continue;
        }

        let metadata = fs::metadata(&child_absolute).map_err(|err| err.to_string())?;
        children.push(NoteTreeNode::File {
            name,
            path: child_relative,
            size: metadata.len(),
            updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
            extension: path_extension(&child_absolute),
        });
    }

    children.sort_by(node_sort);

    Ok(NoteTreeNode::Directory {
        name: node_name_for_directory(root, absolute, relative_path),
        path: relative_path.to_string(),
        children,
    })
}

#[cfg(target_os = "windows")]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
fn hide_command_window(_command: &mut Command) {}

#[derive(Debug, PartialEq)]
struct ProxyEnvironment {
    http_proxy: String,
    https_proxy: String,
    no_proxy: String,
}

fn normalize_http_proxy_endpoint(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Some(value.to_string());
    }
    if lower.contains("://") {
        return None;
    }

    Some(format!("http://{value}"))
}

fn parse_windows_proxy_server(
    proxy_server: &str,
    proxy_override: &str,
) -> Option<ProxyEnvironment> {
    let mut http_proxy = None;
    let mut https_proxy = None;

    if proxy_server.contains('=') {
        for entry in proxy_server.split(';') {
            let Some((kind, endpoint)) = entry.split_once('=') else {
                continue;
            };
            match kind.trim().to_ascii_lowercase().as_str() {
                "http" => http_proxy = normalize_http_proxy_endpoint(endpoint),
                "https" => https_proxy = normalize_http_proxy_endpoint(endpoint),
                _ => {}
            }
        }
    } else {
        let endpoint = normalize_http_proxy_endpoint(proxy_server)?;
        http_proxy = Some(endpoint.clone());
        https_proxy = Some(endpoint);
    }

    let http_proxy = http_proxy.or_else(|| https_proxy.clone())?;
    let https_proxy = https_proxy.unwrap_or_else(|| http_proxy.clone());
    let mut no_proxy = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];

    for entry in proxy_override.split(';').map(str::trim) {
        if entry.is_empty() || entry.eq_ignore_ascii_case("<local>") || entry.contains("://") {
            continue;
        }
        if !no_proxy
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(entry))
        {
            no_proxy.push(entry.to_string());
        }
    }

    Some(ProxyEnvironment {
        http_proxy,
        https_proxy,
        no_proxy: no_proxy.join(","),
    })
}

#[cfg(target_os = "windows")]
fn windows_system_proxy() -> Option<ProxyEnvironment> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }

    let proxy_server = settings.get_value::<String, _>("ProxyServer").ok()?;
    let proxy_override = settings
        .get_value::<String, _>("ProxyOverride")
        .unwrap_or_default();
    parse_windows_proxy_server(&proxy_server, &proxy_override)
}

#[cfg(not(target_os = "windows"))]
fn windows_system_proxy() -> Option<ProxyEnvironment> {
    None
}

fn env_var_is_set(keys: &[&str]) -> bool {
    keys.iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}

fn configure_proxy_environment(command: &mut Command) {
    let has_http_proxy = env_var_is_set(&["http_proxy", "HTTP_PROXY"]);
    let has_https_proxy = env_var_is_set(&["https_proxy", "HTTPS_PROXY"]);
    let mut detected_no_proxy = None;

    if !has_http_proxy && !has_https_proxy {
        if let Some(proxy) = windows_system_proxy() {
            command
                .env("http_proxy", &proxy.http_proxy)
                .env("HTTP_PROXY", &proxy.http_proxy)
                .env("https_proxy", &proxy.https_proxy)
                .env("HTTPS_PROXY", &proxy.https_proxy);
            detected_no_proxy = Some(proxy.no_proxy);

            eprintln!(
                "[inkfellow] AI sidecar using Windows system proxy: {}",
                proxy.https_proxy
            );
        }
    }

    if !env_var_is_set(&["no_proxy", "NO_PROXY"]) {
        let no_proxy = detected_no_proxy.unwrap_or_else(|| "localhost,127.0.0.1,::1".to_string());
        command
            .env("no_proxy", &no_proxy)
            .env("NO_PROXY", &no_proxy);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarRunState {
    Running,
    Idle,
    Unreachable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyRestartAction {
    Wait,
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SidecarRestartPermit {
    Granted,
    Busy,
    Unreachable,
}

const PROXY_RESTART_IDLE_CONFIRMATIONS: u8 = 2;
const PROXY_RESTART_UNREACHABLE_CONFIRMATIONS: u8 = 3;

#[derive(Deserialize)]
struct SidecarRunStateResponse {
    running: bool,
}

#[derive(Deserialize)]
struct SidecarRestartLeaseResponse {
    lease: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

fn parse_sidecar_run_state_response(response: &str) -> Result<SidecarRunState, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .or_else(|| response.split_once("\n\n"))
        .ok_or_else(|| "sidecar run-state response is missing an HTTP body".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "sidecar run-state response has an invalid HTTP status".to_string())?;
    if status != 200 {
        return Err(format!("sidecar run-state endpoint returned HTTP {status}"));
    }

    let response = serde_json::from_str::<SidecarRunStateResponse>(body.trim())
        .map_err(|err| format!("invalid sidecar run-state JSON: {err}"))?;
    Ok(if response.running {
        SidecarRunState::Running
    } else {
        SidecarRunState::Idle
    })
}

fn proxy_restart_action(
    run_state: SidecarRunState,
    idle_confirmations: u8,
    unreachable_confirmations: u8,
) -> ProxyRestartAction {
    match run_state {
        SidecarRunState::Running => ProxyRestartAction::Wait,
        SidecarRunState::Idle if idle_confirmations >= PROXY_RESTART_IDLE_CONFIRMATIONS => {
            ProxyRestartAction::Restart
        }
        SidecarRunState::Unreachable
            if unreachable_confirmations >= PROXY_RESTART_UNREACHABLE_CONFIRMATIONS =>
        {
            ProxyRestartAction::Restart
        }
        SidecarRunState::Idle | SidecarRunState::Unreachable => ProxyRestartAction::Wait,
    }
}

fn query_sidecar_run_state(port: u16, agent_token: &str) -> SidecarRunState {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(1_500);
    let result = (|| -> Result<SidecarRunState, String> {
        let mut stream = TcpStream::connect_timeout(&address, timeout)
            .map_err(|err| format!("failed to connect to sidecar run-state endpoint: {err}"))?;
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|err| format!("failed to configure sidecar read timeout: {err}"))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|err| format!("failed to configure sidecar write timeout: {err}"))?;

        let request = format!(
            "GET /api/run-state?token={agent_token} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|err| format!("failed to query sidecar run state: {err}"))?;

        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|err| format!("failed to read sidecar run state: {err}"))?;
        parse_sidecar_run_state_response(&response)
    })();

    result.unwrap_or(SidecarRunState::Unreachable)
}

fn parse_sidecar_restart_lease_response(response: &str) -> Result<SidecarRestartPermit, String> {
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .or_else(|| response.split_once("\n\n"))
        .ok_or_else(|| "sidecar restart response is missing an HTTP body".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "sidecar restart response has an invalid HTTP status".to_string())?;
    if status == 409 {
        return Ok(SidecarRestartPermit::Busy);
    }
    if status != 200 {
        return Err(format!(
            "sidecar prepare-restart endpoint returned HTTP {status}"
        ));
    }
    let lease = serde_json::from_str::<SidecarRestartLeaseResponse>(body.trim())
        .map_err(|err| format!("invalid sidecar restart lease JSON: {err}"))?;
    if lease.lease.trim().is_empty() || lease.expires_at == 0 {
        return Err("sidecar returned an invalid restart lease".to_string());
    }
    Ok(SidecarRestartPermit::Granted)
}

fn prepare_sidecar_restart(port: u16, agent_token: &str) -> SidecarRestartPermit {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(1_500);
    let mut stream = match TcpStream::connect_timeout(&address, timeout) {
        Ok(stream) => stream,
        Err(_) => return SidecarRestartPermit::Unreachable,
    };
    let result = (|| -> Result<SidecarRestartPermit, String> {
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|err| format!("failed to configure sidecar read timeout: {err}"))?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|err| format!("failed to configure sidecar write timeout: {err}"))?;
        let request = format!(
            "POST /api/prepare-restart?token={agent_token} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|err| format!("failed to request a sidecar restart lease: {err}"))?;
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .map_err(|err| format!("failed to read sidecar restart lease: {err}"))?;
        parse_sidecar_restart_lease_response(&response)
    })();
    // Once a process accepted the TCP connection, any timeout, auth failure, or
    // malformed response is conservatively treated as busy. Only a refused/
    // unreachable port is safe to restart without a lease.
    result.unwrap_or(SidecarRestartPermit::Busy)
}

#[cfg(target_os = "windows")]
fn start_system_proxy_watcher(app: AppHandle) {
    if env_var_is_set(&["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY"]) {
        return;
    }

    std::thread::spawn(move || {
        let mut previous = windows_system_proxy();
        let mut restart_pending = false;
        let mut idle_confirmations = 0_u8;
        let mut unreachable_confirmations = 0_u8;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let current = windows_system_proxy();
            if current != previous {
                previous = current;
                if !restart_pending {
                    eprintln!(
                        "[inkfellow] Windows system proxy changed; AI sidecar restart queued"
                    );
                }
                restart_pending = true;
                idle_confirmations = 0;
                unreachable_confirmations = 0;
            }

            if !restart_pending {
                continue;
            }

            let (port, agent_token) = {
                let state = app.state::<AppState>();
                (state.claude_port, state.agent_token.clone())
            };
            let run_state = query_sidecar_run_state(port, &agent_token);
            match run_state {
                SidecarRunState::Running => {
                    idle_confirmations = 0;
                    unreachable_confirmations = 0;
                }
                SidecarRunState::Idle => {
                    idle_confirmations = idle_confirmations.saturating_add(1);
                    unreachable_confirmations = 0;
                }
                SidecarRunState::Unreachable => {
                    idle_confirmations = 0;
                    unreachable_confirmations = unreachable_confirmations.saturating_add(1);
                }
            }
            if proxy_restart_action(run_state, idle_confirmations, unreachable_confirmations)
                == ProxyRestartAction::Wait
            {
                continue;
            }

            match restart_agent_when_sidecar_safe(&app) {
                SidecarRestartPermit::Granted => {
                    eprintln!(
                        "[inkfellow] AI sidecar granted an idle restart lease; applied pending system proxy restart"
                    );
                }
                SidecarRestartPermit::Unreachable => {
                    eprintln!(
                        "[inkfellow] AI sidecar run-state endpoint is unreachable; restarting sidecar"
                    );
                }
                SidecarRestartPermit::Busy => {
                    idle_confirmations = 0;
                    unreachable_confirmations = 0;
                    continue;
                }
            }
            restart_pending = false;
            idle_confirmations = 0;
            unreachable_confirmations = 0;
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn start_system_proxy_watcher(_app: AppHandle) {}

fn get_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .ok()
}

fn workspace_root() -> PathBuf {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if current_dir.ends_with("src-tauri") {
        current_dir.parent().unwrap_or(&current_dir).to_path_buf()
    } else {
        current_dir
    }
}

fn get_node_path(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "windows")]
    let node_bin = "node.exe";
    #[cfg(not(target_os = "windows"))]
    let node_bin = "node";

    if let Ok(res_dir) = app.path().resource_dir() {
        let bundled = res_dir.join("bin").join(node_bin);
        if bundled.exists() {
            return bundled;
        }
    }

    let root = workspace_root();
    let installed_bundled = root.join("bin").join(node_bin);
    if installed_bundled.exists() {
        return installed_bundled;
    }

    let local_bundled = root.join("src-tauri").join("bin").join(node_bin);
    if local_bundled.exists() {
        return local_bundled;
    }

    PathBuf::from("node")
}

fn find_chat_dir(app: &AppHandle) -> PathBuf {
    let root = workspace_root();
    let mut candidates = vec![
        root.join("_up_").join("desktop-bundle").join("claude-chat"),
        root.join("claude-chat"),
        root.join("desktop-bundle").join("claude-chat"),
    ];

    if let Ok(res_dir) = app.path().resource_dir() {
        candidates.push(
            res_dir
                .join("_up_")
                .join("desktop-bundle")
                .join("claude-chat"),
        );
        candidates.push(res_dir.join("desktop-bundle").join("claude-chat"));
        candidates.push(res_dir.join("_up_").join("claude-chat"));
        candidates.push(res_dir.join("claude-chat"));
    }

    candidates
        .into_iter()
        .find(|candidate| candidate.join("server.js").exists())
        .unwrap_or_else(|| root.join("claude-chat"))
}

fn kill_processes(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut processes = state.processes.lock().unwrap();
        for mut child in processes.drain(..) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_agent(app: &AppHandle) {
    let state = app.state::<AppState>();
    let claude_port = state.claude_port;
    let vault = match ensure_vault_path(app) {
        Ok(path) => path,
        Err(err) => {
            eprintln!("[inkfellow] Cannot resolve vault path: {err}");
            return;
        }
    };

    let node_path = get_node_path(app);
    let chat_dir = find_chat_dir(app);
    let server_js = chat_dir.join("server.js");
    if !server_js.exists() {
        eprintln!("[inkfellow] claude-chat server not found at {server_js:?}");
        return;
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| workspace_root().join(".desktop-data"))
        .join("claude-chat");
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| workspace_root().join(".desktop-config"));
    let _ = fs::create_dir_all(&data_dir);
    let _ = fs::create_dir_all(&config_dir);
    let auth_profile_file = config_dir.join("claude-chat-auth-profile.json");

    let mut command = Command::new(&node_path);
    command
        .arg("--use-env-proxy")
        .arg(&server_js)
        .current_dir(&chat_dir)
        .env("PORT", claude_port.to_string())
        .env("HOST", "127.0.0.1")
        .env("VAULT_PATH", &vault)
        .env("DESKTOP_MODE", "true")
        .env("DESKTOP_AGENT_TOKEN", &state.agent_token)
        .env("CLAUDE_PERMISSION_MODE", "auto")
        .env("CLAUDE_CHAT_DATA_DIR", &data_dir)
        .env("CLAUDE_CHAT_AUTH_PROFILE_FILE", &auth_profile_file)
        .env("NODE_COMPILE_CACHE", data_dir.join("node-compile-cache"));
    configure_proxy_environment(&mut command);
    hide_command_window(&mut command);

    match command.spawn() {
        Ok(child) => {
            eprintln!(
                "[inkfellow] claude-chat sidecar spawned on 127.0.0.1:{claude_port}, PID {}",
                child.id()
            );
            let mut processes = state.processes.lock().unwrap();
            processes.push(child);
        }
        Err(err) => eprintln!("[inkfellow] Failed to spawn claude-chat: {err:?}"),
    }
}

fn restart_agent_locked(app: &AppHandle) {
    kill_processes(app);
    spawn_agent(app);
}

fn restart_agent(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _restart_guard = state
        .agent_restart_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    restart_agent_locked(app);
}

fn restart_agent_when_sidecar_safe(app: &AppHandle) -> SidecarRestartPermit {
    let state = app.state::<AppState>();
    let _restart_guard = state
        .agent_restart_lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let permit = prepare_sidecar_restart(state.claude_port, &state.agent_token);
    if permit != SidecarRestartPermit::Busy {
        restart_agent_locked(app);
    }
    permit
}

fn agent_ready(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn ensure_git_repo(path: &Path) {
    if path.join(".git").exists() {
        return;
    }
    let mut command = Command::new("git");
    command.arg("-C").arg(path).arg("init");
    hide_command_window(&mut command);
    let _ = command.output();
}

fn run_git(path: &Path, args: &[&str]) -> Result<GitOutput, String> {
    let _guard = GIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut command = Command::new("git");
    command.arg("-C").arg(path);
    // 非 ASCII 路径（中文文件名）默认会被八进制转义，关掉以输出原始 UTF-8
    command.arg("-c").arg("core.quotepath=false");
    for arg in args {
        command.arg(arg);
    }
    hide_command_window(&mut command);
    let output = command.output().map_err(|err| err.to_string())?;
    Ok(GitOutput {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code(),
    })
}

fn parse_branch_status(first_line: &str) -> (Option<String>, u32, u32) {
    let clean = first_line.trim_start_matches("## ").trim();
    if clean.is_empty() {
        return (None, 0, 0);
    }

    let branch = clean
        .split("...")
        .next()
        .unwrap_or(clean)
        .split(' ')
        .next()
        .map(|value| value.to_string());

    let ahead = clean
        .split("ahead ")
        .nth(1)
        .and_then(|rest| rest.split(|ch| ch == ',' || ch == ']').next())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0);

    let behind = clean
        .split("behind ")
        .nth(1)
        .and_then(|rest| rest.split(|ch| ch == ',' || ch == ']').next())
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(0);

    (branch, ahead, behind)
}

fn git_name_from_path(path: &str) -> String {
    path.split('/').next_back().unwrap_or(path).to_string()
}

/// 解开 git 对特殊字符路径的 C 风格引用（如 "\346\226\207.md"），
/// 含引号包裹、八进制字节与常见转义符。未被引用的路径原样返回。
fn unquote_git_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('"') || !trimmed.ends_with('"') {
        return trimmed.to_string();
    }

    let inner = trimmed[1..trimmed.len() - 1].as_bytes();
    let mut bytes = Vec::with_capacity(inner.len());
    let mut i = 0;
    while i < inner.len() {
        if inner[i] == b'\\' && i + 1 < inner.len() {
            let next = inner[i + 1];
            if next.is_ascii_digit() {
                let mut value = 0u32;
                let mut count = 0;
                while count < 3 && i + 1 < inner.len() && inner[i + 1].is_ascii_digit() {
                    value = value * 8 + u32::from(inner[i + 1] - b'0');
                    i += 1;
                    count += 1;
                }
                bytes.push(value as u8);
            } else {
                bytes.push(match next {
                    b'n' => b'\n',
                    b't' => b'\t',
                    b'r' => b'\r',
                    other => other,
                });
                i += 1;
            }
        } else {
            bytes.push(inner[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&bytes).to_string()
}

fn git_file_kind(root: &Path, relative_path: &str) -> String {
    let path = root.join(relative_to_path_buf(relative_path));
    if path.is_dir() {
        "folder".to_string()
    } else {
        "file".to_string()
    }
}

fn parse_git_status_entries(root: &Path, entries: &[String]) -> Vec<GitFileStatus> {
    entries
        .iter()
        .filter_map(|entry| {
            if entry.len() < 3 {
                return None;
            }
            let code = entry.get(0..2).unwrap_or("").trim();
            let raw_path = entry.get(3..).unwrap_or("").trim();
            if raw_path.is_empty() {
                return None;
            }

            let (state, path) = if raw_path.contains(" -> ") {
                ("renamed", raw_path.split(" -> ").last().unwrap_or(raw_path))
            } else if code == "??" || code.contains('A') {
                ("added", raw_path)
            } else if code.contains('D') {
                ("deleted", raw_path)
            } else {
                ("modified", raw_path)
            };

            let path = unquote_git_path(path).replace('\\', "/");
            Some(GitFileStatus {
                name: git_name_from_path(&path),
                kind: git_file_kind(root, &path),
                path,
                state: state.to_string(),
            })
        })
        .collect()
}

fn git_last_sync(path: &Path) -> Option<String> {
    let output = run_git(path, &["log", "-1", "--format=%cI"]).ok()?;
    if !output.success {
        return None;
    }
    let value = output.stdout.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn parse_git_diff(path: &str, raw: &str) -> GitFileDiff {
    let binary = raw.lines().any(|line| line.starts_with("Binary files "));
    let mut lines = Vec::new();
    let mut add_count = 0;
    let mut remove_count = 0;

    for line in raw.lines() {
        if line.starts_with("diff --git ")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
        {
            continue;
        }

        let line_type = if line.starts_with("@@") {
            "hunk"
        } else if line.starts_with('+') {
            add_count += 1;
            "add"
        } else if line.starts_with('-') {
            remove_count += 1;
            "remove"
        } else {
            "context"
        };

        let content = if line_type == "add" || line_type == "remove" {
            line.chars().skip(1).collect::<String>()
        } else {
            line.to_string()
        };

        lines.push(GitDiffLine {
            line_type: line_type.to_string(),
            content,
        });
    }

    GitFileDiff {
        path: path.to_string(),
        binary,
        lines,
        add_count,
        remove_count,
    }
}

#[tauri::command]
async fn get_desktop_state(app: AppHandle) -> Result<DesktopState, String> {
    let vault = ensure_vault_path(&app)?;
    let state = app.state::<AppState>();
    let port = state.claude_port;
    Ok(DesktopState {
        vault_path: vault.to_string_lossy().to_string(),
        agent_url: format!("http://127.0.0.1:{port}"),
        agent_port: port,
        agent_ready: agent_ready(port),
        agent_token: state.agent_token.clone(),
    })
}

#[tauri::command]
async fn agent_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    Ok(agent_ready(state.claude_port))
}

#[tauri::command]
async fn select_and_set_vault(app: AppHandle) -> Result<DesktopState, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("Select notes vault")
        .pick_folder()
    else {
        return Err("User cancelled selection.".to_string());
    };

    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    save_vault_path(&app, &path)?;
    allow_vault_assets(&app, &path)?;
    ensure_git_repo(&path);
    if let Err(err) = start_vault_watcher(&app) {
        eprintln!("[inkfellow] vault watcher failed: {err}");
    }
    restart_agent(&app);
    get_desktop_state(app).await
}

#[tauri::command]
async fn set_vault_path(app: AppHandle, path: String) -> Result<DesktopState, String> {
    let path_buf = PathBuf::from(path);
    if !path_buf.exists() {
        return Err("Path does not exist.".to_string());
    }
    if !path_buf.is_dir() {
        return Err("Path is not a folder.".to_string());
    }
    save_vault_path(&app, &path_buf)?;
    allow_vault_assets(&app, &path_buf)?;
    ensure_git_repo(&path_buf);
    if let Err(err) = start_vault_watcher(&app) {
        eprintln!("[inkfellow] vault watcher failed: {err}");
    }
    restart_agent(&app);
    get_desktop_state(app).await
}

#[tauri::command]
async fn list_notes_tree(app: AppHandle) -> Result<TreeResponse, String> {
    let root = vault_root(&app)?;
    Ok(TreeResponse {
        root: walk_directory(&root, &root, "")?,
        generated_at: now_secs(),
    })
}

#[tauri::command]
async fn read_note(app: AppHandle, path: String) -> Result<NoteResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_text_note(&resolved.absolute) {
        return Err("Only Markdown and HTML files can be read as text.".to_string());
    }

    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let content = fs::read_to_string(&resolved.absolute).map_err(|err| err.to_string())?;
    Ok(NoteResponse {
        name: resolved
            .absolute
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("note")
            .to_string(),
        path: resolved.relative,
        content,
        size: metadata.len(),
        updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
        extension: path_extension(&resolved.absolute),
    })
}

#[tauri::command]
async fn read_asset(app: AppHandle, path: String) -> Result<AssetResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_image_note(&resolved.absolute) {
        return Err("Only image files can be previewed.".to_string());
    }

    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let bytes = fs::read(&resolved.absolute).map_err(|err| err.to_string())?;
    let extension = path_extension(&resolved.absolute);
    let mime = mime_for_extension(&extension).to_string();
    let data_url = format!(
        "data:{mime};base64,{}",
        general_purpose::STANDARD.encode(bytes)
    );

    Ok(AssetResponse {
        name: resolved
            .absolute
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or("image")
            .to_string(),
        path: resolved.relative,
        data_url,
        mime,
        size: metadata.len(),
        updated_at: metadata.modified().map(unix_secs).unwrap_or(0),
        extension,
    })
}

#[tauri::command]
async fn paste_image(
    app: AppHandle,
    note_path: String,
    original_name: String,
    mime_type: String,
    data_base64: String,
) -> Result<PastedImageResponse, String> {
    let extension = pasted_image_extension(&mime_type)
        .ok_or_else(|| "仅支持 PNG、JPEG、WebP 和 GIF 图片。".to_string())?;
    let max_base64_len = MAX_PASTED_IMAGE_BYTES.saturating_mul(4) / 3 + 8;
    if data_base64.len() > max_base64_len {
        return Err("图片不能超过 20 MB。".to_string());
    }

    let bytes = general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "剪贴板图片数据无效。".to_string())?;
    if bytes.is_empty() {
        return Err("图片内容为空。".to_string());
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err("图片不能超过 20 MB。".to_string());
    }
    if !is_valid_pasted_image(&mime_type, &bytes) {
        return Err("剪贴板图片格式无效。".to_string());
    }

    let resolved_note = resolve_existing_path(&app, &note_path, false)?;
    if path_extension(&resolved_note.absolute) != "md" {
        return Err("图片只能粘贴到 Markdown 笔记。".to_string());
    }
    let base_name = pasted_image_base_name(&original_name);
    write_pasted_image_file(
        &resolved_note.absolute,
        &resolved_note.relative,
        &base_name,
        extension,
        &bytes,
    )
}

#[tauri::command]
async fn write_note(app: AppHandle, path: String, content: String) -> Result<NoteResponse, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    if !is_text_note(&resolved.absolute) {
        return Err("Only Markdown and HTML files can be edited.".to_string());
    }

    fs::write(&resolved.absolute, content.as_bytes()).map_err(|err| err.to_string())?;
    read_note(app, resolved.relative).await
}

#[tauri::command]
async fn create_note(
    app: AppHandle,
    folder: String,
    title: String,
) -> Result<NoteResponse, String> {
    let clean_folder = normalize_relative_path(&folder, true)?;
    let mut clean_name = sanitize_name_segment(&title)?;
    if path_extension(Path::new(&clean_name)).is_empty() {
        clean_name.push_str(".md");
    }

    if !is_text_note(Path::new(&clean_name)) {
        return Err("Only Markdown and HTML notes can be created.".to_string());
    }

    let relative = if clean_folder.is_empty() {
        clean_name.clone()
    } else {
        format!("{clean_folder}/{clean_name}")
    };
    let resolved = resolve_new_path(&app, &relative)?;
    if resolved.absolute.exists() {
        return Err("A note with this name already exists.".to_string());
    }

    let title_without_ext = Path::new(&clean_name)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("Untitled");
    let initial = if path_extension(Path::new(&clean_name)) == "md" {
        format!("# {title_without_ext}\n\n")
    } else {
        String::new()
    };

    fs::write(&resolved.absolute, initial.as_bytes()).map_err(|err| err.to_string())?;
    read_note(app, resolved.relative).await
}

#[tauri::command]
async fn create_folder(app: AppHandle, parent: String, name: String) -> Result<(), String> {
    let clean_parent = normalize_relative_path(&parent, true)?;
    let clean_name = sanitize_name_segment(&name)?;
    let relative = if clean_parent.is_empty() {
        clean_name
    } else {
        format!("{clean_parent}/{clean_name}")
    };
    let resolved = resolve_new_path(&app, &relative)?;
    if resolved.absolute.exists() {
        return Err("A folder with this name already exists.".to_string());
    }
    fs::create_dir_all(&resolved.absolute).map_err(|err| err.to_string())?;
    let keep_file = resolved.absolute.join(".gitkeep");
    let _ = fs::write(keep_file, b"");
    Ok(())
}

#[tauri::command]
async fn rename_entry(app: AppHandle, path: String, name: String) -> Result<String, String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    let clean_name = sanitize_name_segment(&name)?;
    if metadata.is_file() && !is_note_file(Path::new(&clean_name)) {
        return Err("Only supported note files can be renamed.".to_string());
    }
    if metadata.is_dir() && resolved.relative.is_empty() {
        return Err("The root folder cannot be renamed.".to_string());
    }

    let parent = resolved
        .absolute
        .parent()
        .ok_or_else(|| "Invalid path.".to_string())?;
    let target = parent.join(&clean_name);
    if target.exists() {
        return Err("A file or folder with this name already exists.".to_string());
    }
    fs::rename(&resolved.absolute, &target).map_err(|err| err.to_string())?;

    let root = vault_root(&app)?;
    let relative = target
        .strip_prefix(root)
        .map(to_slash_path)
        .map_err(|err| err.to_string())?;
    Ok(relative)
}

#[tauri::command]
async fn delete_entry(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = resolve_existing_path(&app, &path, false)?;
    let metadata = fs::metadata(&resolved.absolute).map_err(|err| err.to_string())?;
    if metadata.is_dir() {
        if resolved.relative.is_empty() {
            return Err("The root folder cannot be deleted.".to_string());
        }
        fs::remove_dir_all(&resolved.absolute).map_err(|err| err.to_string())?;
    } else if metadata.is_file() {
        fs::remove_file(&resolved.absolute).map_err(|err| err.to_string())?;
    } else {
        return Err("Only files and folders can be deleted.".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn search_notes(app: AppHandle, query: String) -> Result<Vec<SearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(Vec::new());
    }

    let root = vault_root(&app)?;
    let mut hits = Vec::new();
    search_walk(&root, &root, "", &needle, &mut hits)?;
    Ok(hits)
}

fn search_walk(
    root: &Path,
    absolute: &Path,
    relative_path: &str,
    needle: &str,
    hits: &mut Vec<SearchHit>,
) -> Result<(), String> {
    if hits.len() >= 80 {
        return Ok(());
    }

    for entry_result in fs::read_dir(absolute).map_err(|err| err.to_string())? {
        let entry = entry_result.map_err(|err| err.to_string())?;
        let file_type = entry.file_type().map_err(|err| err.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        if has_excluded_segment(&child_relative) {
            continue;
        }

        let path = entry.path();
        if file_type.is_dir() {
            search_walk(root, &path, &child_relative, needle, hits)?;
            continue;
        }
        if !file_type.is_file() || !is_text_note(&path) {
            continue;
        }

        let name_hit = name.to_lowercase().contains(needle);
        let content = fs::read_to_string(&path).unwrap_or_default();
        let content_lower = content.to_lowercase();
        if !name_hit && !content_lower.contains(needle) {
            continue;
        }

        let snippet = content
            .lines()
            .find(|line| line.to_lowercase().contains(needle))
            .unwrap_or("")
            .trim()
            .chars()
            .take(180)
            .collect::<String>();
        let rel = path
            .strip_prefix(root)
            .map(to_slash_path)
            .unwrap_or(child_relative);
        hits.push(SearchHit {
            path: rel,
            name,
            snippet,
        });
    }
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http/https URLs are supported".to_string());
    }
    let url = parsed.as_str();

    #[cfg(target_os = "windows")]
    std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
struct WikiBacklink {
    #[serde(rename = "sourcePath")]
    source_path: String,
    #[serde(rename = "sourceName")]
    source_name: String,
    context: String,
}

#[tauri::command]
async fn wiki_backlinks(app: AppHandle, path: String) -> Result<Vec<WikiBacklink>, String> {
    let root = vault_root(&app)?;
    let path_norm = path.replace('\\', "/");
    let note_stem = Path::new(&path_norm)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let path_key = {
        let p = path_norm.to_lowercase();
        if p.ends_with(".md") {
            p[..p.len() - 3].to_string()
        } else {
            p
        }
    };

    let mut backlinks = Vec::new();
    wiki_backlink_walk(&root, &root, "", &note_stem, &path_key, &mut backlinks)?;
    Ok(backlinks)
}

fn wiki_backlink_walk(
    root: &Path,
    absolute: &Path,
    relative_path: &str,
    note_stem: &str,
    path_key: &str,
    backlinks: &mut Vec<WikiBacklink>,
) -> Result<(), String> {
    for entry_result in fs::read_dir(absolute).map_err(|e| e.to_string())? {
        let entry = entry_result.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };

        if has_excluded_segment(&child_relative) {
            continue;
        }

        let abs_path = entry.path();
        if file_type.is_dir() {
            wiki_backlink_walk(
                root,
                &abs_path,
                &child_relative,
                note_stem,
                path_key,
                backlinks,
            )?;
            continue;
        }

        if !file_type.is_file() || abs_path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = fs::read_to_string(&abs_path).unwrap_or_default();
        let source_name = Path::new(&name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&name)
            .to_string();

        // Strip code blocks line-by-line, then scan for [[...]] links
        let mut clean = String::with_capacity(content.len());
        let mut in_code = false;
        for line in content.lines() {
            let t = line.trim();
            if t.starts_with("```") || t.starts_with("~~~") {
                in_code = !in_code;
                clean.push('\n');
            } else if !in_code {
                clean.push_str(line);
                clean.push('\n');
            } else {
                clean.push('\n');
            }
        }

        let mut pos = 0;
        let bytes = clean.as_bytes();
        while pos < clean.len() {
            let rest = &clean[pos..];
            let Some(open_rel) = rest.find("[[") else {
                break;
            };
            let open_abs = pos + open_rel;
            let inner_start = open_abs + 2;
            let Some(close_rel) = clean[inner_start..].find("]]") else {
                pos = inner_start;
                continue;
            };
            let inner = &clean[inner_start..inner_start + close_rel];

            let is_embed = open_abs > 0 && bytes.get(open_abs - 1) == Some(&b'!');

            // Extract raw target (before | and before #)
            let target_raw = inner.split('|').next().unwrap_or(inner);
            let target_raw = target_raw.split('#').next().unwrap_or(target_raw).trim();
            let target = normalize_wiki_target_key(target_raw);
            let target_for_media = target_raw.to_lowercase();

            // Skip media embeds
            let is_media = is_embed
                && matches!(
                    Path::new(&target_for_media)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or(""),
                    "png"
                        | "jpg"
                        | "jpeg"
                        | "gif"
                        | "webp"
                        | "svg"
                        | "bmp"
                        | "ico"
                        | "avif"
                        | "mp4"
                        | "webm"
                        | "mov"
                        | "mp3"
                        | "wav"
                        | "ogg"
                        | "flac"
                        | "pdf"
                );

            if !is_media && (target == note_stem || target == path_key) {
                let line_start = clean[..open_abs].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = clean[open_abs..]
                    .find('\n')
                    .map(|i| open_abs + i)
                    .unwrap_or(clean.len());
                let context = clean[line_start..line_end]
                    .trim()
                    .chars()
                    .take(120)
                    .collect::<String>();
                backlinks.push(WikiBacklink {
                    source_path: child_relative.clone(),
                    source_name: source_name.clone(),
                    context,
                });
            }

            pos = inner_start + close_rel + 2;
        }
    }
    Ok(())
}

fn normalize_wiki_target_key(target: &str) -> String {
    let mut key = target
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_lowercase();
    if key.ends_with(".md") {
        key.truncate(key.len() - 3);
    }
    key
}

fn compute_git_status(path: &Path) -> Result<GitStatus, String> {
    let initialized = path.join(".git").exists();
    if !initialized {
        return Ok(GitStatus {
            initialized: false,
            clean: true,
            branch: None,
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
            files: Vec::new(),
            last_sync: None,
            raw: "Git repository is not initialized.".to_string(),
        });
    }

    let output = run_git(path, &["status", "--porcelain=v1", "-b"])?;
    let raw = if output.stdout.trim().is_empty() {
        output.stderr.clone()
    } else {
        output.stdout.clone()
    };
    let mut lines = raw.lines();
    let first = lines.next().unwrap_or("");
    let (branch, ahead, behind) = parse_branch_status(first);
    let entries = lines.map(|line| line.to_string()).collect::<Vec<_>>();
    let files = parse_git_status_entries(path, &entries);
    Ok(GitStatus {
        initialized: true,
        clean: files.is_empty() && ahead == 0 && behind == 0,
        branch,
        ahead,
        behind,
        entries,
        files,
        last_sync: git_last_sync(path),
        raw,
    })
}

fn do_git_pull(path: &Path) -> Result<GitOutput, String> {
    run_git(path, &["pull", "--rebase", "--autostash"])
}

fn do_git_push(path: &Path) -> Result<GitOutput, String> {
    run_git(path, &["push"])
}

fn do_git_commit(path: &Path, message: &str) -> Result<GitOutput, String> {
    let add = run_git(path, &["add", "-A"])?;
    if !add.success {
        return Ok(add);
    }

    let staged = run_git(path, &["diff", "--cached", "--quiet"])?;
    if staged.success {
        return Ok(GitOutput {
            success: true,
            stdout: "No staged changes to commit.".to_string(),
            stderr: String::new(),
            code: Some(0),
        });
    }

    let clean_message = if message.trim().is_empty() {
        "Update notes"
    } else {
        message.trim()
    };
    run_git(
        path,
        &[
            "-c",
            "user.name=Inkfellow Desktop",
            "-c",
            "user.email=desktop@inkfellow.local",
            "commit",
            "-m",
            clean_message,
        ],
    )
}

/* ── 同步引擎：单一后台 worker 串行调度所有同步动作 ── */

enum SyncJob {
    Pull { force: bool },
    CommitPush { message: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEvent {
    /// pulling | syncing | idle
    phase: String,
    /// pull | commitPush
    kind: String,
    pulled_changes: bool,
    feedback: Option<String>,
    error: Option<String>,
    status: Option<GitStatus>,
}

fn emit_sync(app: &AppHandle, event: SyncEvent) {
    let _ = app.emit("sync-state", event);
}

fn emit_sync_done(
    app: &AppHandle,
    kind: &str,
    pulled: bool,
    feedback: Option<String>,
    error: Option<String>,
) {
    let status = ensure_vault_path(app)
        .and_then(|path| compute_git_status(&path))
        .ok();
    emit_sync(
        app,
        SyncEvent {
            phase: "idle".to_string(),
            kind: kind.to_string(),
            pulled_changes: pulled,
            feedback,
            error,
            status,
        },
    );
}

fn emit_sync_phase(app: &AppHandle, phase: &str, kind: &str) {
    emit_sync(
        app,
        SyncEvent {
            phase: phase.to_string(),
            kind: kind.to_string(),
            pulled_changes: false,
            feedback: None,
            error: None,
            status: None,
        },
    );
}

fn pull_brought_changes(out: &GitOutput) -> bool {
    let stdout = out.stdout.trim();
    !stdout.is_empty() && !stdout.to_lowercase().contains("already up to date")
}

/// 失败退避：30s 起步指数翻倍，上限 10 分钟
fn pull_min_interval(fail_streak: u32) -> Duration {
    let secs = 30u64.saturating_mul(1 << fail_streak.min(5));
    Duration::from_secs(secs.min(600))
}

fn sync_worker(app: AppHandle, rx: mpsc::Receiver<SyncJob>) {
    let mut last_pull_ok: Option<Instant> = None;
    let mut fail_streak: u32 = 0;

    while let Ok(job) = rx.recv() {
        let Ok(vault) = ensure_vault_path(&app) else {
            continue;
        };
        if !vault.join(".git").exists() {
            continue;
        }

        match job {
            SyncJob::Pull { force } => {
                if !force {
                    let throttled = last_pull_ok
                        .map(|at| at.elapsed() < pull_min_interval(fail_streak))
                        .unwrap_or(false);
                    if throttled {
                        continue;
                    }
                }

                emit_sync_phase(&app, "pulling", "pull");
                match do_git_pull(&vault) {
                    Ok(out) if out.success => {
                        fail_streak = 0;
                        last_pull_ok = Some(Instant::now());
                        emit_sync_done(&app, "pull", pull_brought_changes(&out), None, None);
                    }
                    Ok(out) => {
                        fail_streak += 1;
                        last_pull_ok = Some(Instant::now());
                        let detail = if out.stderr.trim().is_empty() {
                            out.stdout
                        } else {
                            out.stderr
                        };
                        emit_sync_done(&app, "pull", false, None, Some(detail.trim().to_string()));
                    }
                    Err(err) => {
                        fail_streak += 1;
                        last_pull_ok = Some(Instant::now());
                        emit_sync_done(&app, "pull", false, None, Some(err));
                    }
                }
            }
            SyncJob::CommitPush { message } => {
                emit_sync_phase(&app, "syncing", "commitPush");
                let result = (|| -> Result<(GitOutput, Vec<GitOutput>), String> {
                    let pull = do_git_pull(&vault)?;
                    if !pull.success {
                        let detail = if pull.stderr.trim().is_empty() {
                            pull.stdout.clone()
                        } else {
                            pull.stderr.clone()
                        };
                        return Err(detail.trim().to_string());
                    }
                    let commit = do_git_commit(&vault, &message)?;
                    if !commit.success {
                        let detail = if commit.stderr.trim().is_empty() {
                            commit.stdout.clone()
                        } else {
                            commit.stderr.clone()
                        };
                        return Err(detail.trim().to_string());
                    }
                    let push = do_git_push(&vault)?;
                    if !push.success {
                        let detail = if push.stderr.trim().is_empty() {
                            push.stdout.clone()
                        } else {
                            push.stderr.clone()
                        };
                        return Err(detail.trim().to_string());
                    }
                    Ok((pull, vec![commit, push]))
                })();

                match result {
                    Ok((pull, outputs)) => {
                        last_pull_ok = Some(Instant::now());
                        fail_streak = 0;
                        let summary = outputs
                            .iter()
                            .map(|o| [o.stdout.trim(), o.stderr.trim()].join("\n"))
                            .collect::<Vec<_>>()
                            .join("\n")
                            .trim()
                            .to_string();
                        let feedback = if summary.is_empty() {
                            "已同步。".to_string()
                        } else {
                            summary
                        };
                        emit_sync_done(
                            &app,
                            "commitPush",
                            pull_brought_changes(&pull),
                            Some(feedback),
                            None,
                        );
                    }
                    Err(err) => {
                        emit_sync_done(&app, "commitPush", false, None, Some(err));
                    }
                }
            }
        }
    }
}

fn start_sync_worker(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<SyncJob>();
    let state = app.state::<AppState>();
    *state.sync_tx.lock().unwrap() = Some(tx);

    let handle = app.clone();
    std::thread::spawn(move || sync_worker(handle, rx));
}

fn queue_sync_job(app: &AppHandle, job: SyncJob) -> Result<(), String> {
    let state = app.state::<AppState>();
    let tx = state.sync_tx.lock().unwrap();
    tx.as_ref()
        .ok_or_else(|| "Sync engine is not running.".to_string())?
        .send(job)
        .map_err(|_| "Sync engine is not running.".to_string())
}

#[tauri::command]
async fn sync_request_pull(app: AppHandle, force: Option<bool>) -> Result<(), String> {
    queue_sync_job(
        &app,
        SyncJob::Pull {
            force: force.unwrap_or(false),
        },
    )
}

#[tauri::command]
async fn sync_commit_and_push(app: AppHandle, message: String) -> Result<(), String> {
    queue_sync_job(&app, SyncJob::CommitPush { message })
}

#[tauri::command]
async fn git_status(app: AppHandle) -> Result<GitStatus, String> {
    let path = ensure_vault_path(&app)?;
    compute_git_status(&path)
}

#[tauri::command]
async fn git_init(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    run_git(&path, &["init"])
}

#[tauri::command]
async fn git_pull(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    do_git_pull(&path)
}

#[tauri::command]
async fn git_push(app: AppHandle) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    do_git_push(&path)
}

#[tauri::command]
async fn git_commit(app: AppHandle, message: String) -> Result<GitOutput, String> {
    let path = ensure_vault_path(&app)?;
    do_git_commit(&path, &message)
}

#[tauri::command]
async fn git_commit_and_push(app: AppHandle, message: String) -> Result<Vec<GitOutput>, String> {
    let path = ensure_vault_path(&app)?;
    let commit = do_git_commit(&path, &message)?;
    if !commit.success {
        return Ok(vec![commit]);
    }
    let push = do_git_push(&path)?;
    Ok(vec![commit, push])
}

#[tauri::command]
async fn git_history(app: AppHandle) -> Result<Vec<GitCommitRecord>, String> {
    let path = ensure_vault_path(&app)?;
    if !path.join(".git").exists() {
        return Ok(Vec::new());
    }

    let output = run_git(
        &path,
        &[
            "log",
            "-30",
            "--pretty=format:%h%x1f%s%x1f%an%x1f%cd",
            "--date=format-local:%Y-%m-%d %H:%M",
        ],
    )?;
    if !output.success {
        return Err(if output.stderr.trim().is_empty() {
            "Failed to load git history.".to_string()
        } else {
            output.stderr
        });
    }

    Ok(output
        .stdout
        .lines()
        .filter_map(|line| {
            let parts = line.split('\x1f').collect::<Vec<_>>();
            if parts.len() < 4 {
                return None;
            }
            Some(GitCommitRecord {
                hash: parts[0].to_string(),
                message: parts[1].to_string(),
                author: parts[2].to_string(),
                date: parts[3].to_string(),
            })
        })
        .collect())
}

#[tauri::command]
async fn git_diff(app: AppHandle, path: String) -> Result<GitFileDiff, String> {
    let root = ensure_vault_path(&app)?;
    let relative = normalize_relative_path(&path, false)?;

    let status = run_git(&root, &["status", "--porcelain=v1", "--", &relative])?;
    let is_untracked = status.stdout.lines().any(|line| line.starts_with("??"));
    if is_untracked {
        let resolved = resolve_existing_path(&app, &relative, false)?;
        let content = fs::read_to_string(&resolved.absolute).unwrap_or_default();
        let raw = content
            .lines()
            .map(|line| format!("+{line}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(parse_git_diff(&relative, &raw));
    }

    let output = run_git(&root, &["diff", "--", &relative])?;
    if !output.success {
        return Err(if output.stderr.trim().is_empty() {
            "Failed to load diff.".to_string()
        } else {
            output.stderr
        });
    }
    Ok(parse_git_diff(&relative, &output.stdout))
}

#[tauri::command]
async fn git_discard(app: AppHandle, path: String) -> Result<(), String> {
    let root = ensure_vault_path(&app)?;
    let relative = normalize_relative_path(&path, false)?;

    let status = run_git(&root, &["status", "--porcelain=v1", "--", &relative])?;
    let is_untracked = status.stdout.lines().any(|line| line.starts_with("??"));

    if is_untracked {
        let resolved = match resolve_existing_path(&app, &relative, false) {
            Ok(resolved) => resolved,
            Err(_) => return Ok(()),
        };
        if resolved.absolute.is_dir() {
            fs::remove_dir_all(&resolved.absolute).map_err(|err| err.to_string())?;
        } else {
            fs::remove_file(&resolved.absolute).map_err(|err| err.to_string())?;
        }
        return Ok(());
    }

    let restore = run_git(
        &root,
        &["restore", "--staged", "--worktree", "--", &relative],
    )?;
    if restore.success {
        return Ok(());
    }

    let checkout = run_git(&root, &["checkout", "--", &relative])?;
    if checkout.success {
        Ok(())
    } else {
        Err(if checkout.stderr.trim().is_empty() {
            restore.stderr
        } else {
            checkout.stderr
        })
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let claude_port = get_free_port().unwrap_or(8089);
    let agent_token = uuid::Uuid::new_v4().to_string();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(AppState {
            processes: Mutex::new(Vec::new()),
            agent_restart_lock: Mutex::new(()),
            claude_port,
            agent_token,
            sync_tx: Mutex::new(None),
            vault_watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_state,
            agent_status,
            select_and_set_vault,
            set_vault_path,
            list_notes_tree,
            read_note,
            read_asset,
            paste_image,
            write_note,
            create_note,
            create_folder,
            rename_entry,
            delete_entry,
            search_notes,
            wiki_backlinks,
            open_external_url,
            git_status,
            git_init,
            git_pull,
            git_push,
            git_commit,
            git_commit_and_push,
            git_history,
            git_diff,
            git_discard,
            sync_request_pull,
            sync_commit_and_push
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(vault) = ensure_vault_path(&handle) {
                if let Err(err) = allow_vault_assets(&handle, &vault) {
                    eprintln!("[inkfellow] HTML asset scope setup failed: {err}");
                }
                ensure_git_repo(&vault);
            }
            if let Err(err) = start_vault_watcher(&handle) {
                eprintln!("[inkfellow] vault watcher failed: {err}");
            }
            start_sync_worker(&handle);
            spawn_agent(&handle);
            start_system_proxy_watcher(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            kill_processes(app_handle);
        }
    });
}

#[cfg(test)]
mod proxy_tests {
    use super::*;

    #[test]
    fn parses_single_windows_proxy_for_both_protocols() {
        let proxy =
            parse_windows_proxy_server("127.0.0.1:10809", "<local>;localhost;127.*;192.168.*")
                .unwrap();

        assert_eq!(proxy.http_proxy, "http://127.0.0.1:10809");
        assert_eq!(proxy.https_proxy, "http://127.0.0.1:10809");
        assert_eq!(proxy.no_proxy, "localhost,127.0.0.1,::1,127.*,192.168.*");
    }

    #[test]
    fn parses_protocol_specific_windows_proxy() {
        let proxy = parse_windows_proxy_server(
            "http=127.0.0.1:8080;https=https://proxy.example:8443;socks=127.0.0.1:1080",
            "",
        )
        .unwrap();

        assert_eq!(proxy.http_proxy, "http://127.0.0.1:8080");
        assert_eq!(proxy.https_proxy, "https://proxy.example:8443");
        assert_eq!(proxy.no_proxy, "localhost,127.0.0.1,::1");
    }
    #[test]
    fn parses_sidecar_running_and_idle_responses() {
        let running = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"running\":true}";
        let idle = "HTTP/1.0 200 OK\n\n{\"running\":false}";

        assert_eq!(
            parse_sidecar_run_state_response(running).unwrap(),
            SidecarRunState::Running
        );
        assert_eq!(
            parse_sidecar_run_state_response(idle).unwrap(),
            SidecarRunState::Idle
        );
    }

    #[test]
    fn rejects_invalid_sidecar_run_state_responses() {
        assert!(parse_sidecar_run_state_response(
            "HTTP/1.0 401 Unauthorized\r\n\r\n{\"running\":false}"
        )
        .is_err());
        assert!(
            parse_sidecar_run_state_response("HTTP/1.0 200 OK\r\n\r\n{\"running\":\"yes\"}")
                .is_err()
        );
    }

    #[test]
    fn parses_restart_lease_and_busy_responses() {
        let granted = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"lease\":\"lease-1\",\"expiresAt\":123}";
        let busy =
            "HTTP/1.0 409 Conflict\r\nContent-Type: application/json\r\n\r\n{\"running\":true}";

        assert_eq!(
            parse_sidecar_restart_lease_response(granted).unwrap(),
            SidecarRestartPermit::Granted
        );
        assert_eq!(
            parse_sidecar_restart_lease_response(busy).unwrap(),
            SidecarRestartPermit::Busy
        );
        assert!(parse_sidecar_restart_lease_response(
            "HTTP/1.0 200 OK\r\n\r\n{\"lease\":\"\",\"expiresAt\":0}"
        )
        .is_err());
    }

    #[test]
    fn proxy_restart_waits_only_for_a_running_sidecar() {
        assert_eq!(
            proxy_restart_action(SidecarRunState::Running, 10, 10),
            ProxyRestartAction::Wait
        );
        assert_eq!(
            proxy_restart_action(SidecarRunState::Idle, 1, 0),
            ProxyRestartAction::Wait
        );
        assert_eq!(
            proxy_restart_action(SidecarRunState::Idle, 2, 0),
            ProxyRestartAction::Restart
        );
        assert_eq!(
            proxy_restart_action(SidecarRunState::Unreachable, 0, 2),
            ProxyRestartAction::Wait
        );
        assert_eq!(
            proxy_restart_action(SidecarRunState::Unreachable, 0, 3),
            ProxyRestartAction::Restart
        );
    }
}

#[cfg(test)]
mod pasted_image_tests {
    use super::*;

    #[test]
    fn validates_supported_raster_signatures() {
        assert!(is_valid_pasted_image(
            "image/png",
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        ));
        assert!(is_valid_pasted_image("image/jpeg", &[0xff, 0xd8, 0xff]));
        assert!(is_valid_pasted_image("image/gif", b"GIF89a"));
        assert!(is_valid_pasted_image("image/webp", b"RIFF\0\0\0\0WEBP"));
        assert!(!is_valid_pasted_image("image/png", b"not an image"));
        assert!(!is_valid_pasted_image("image/svg+xml", b"<svg></svg>"));
    }

    #[test]
    fn sanitizes_pasted_image_names() {
        assert_eq!(pasted_image_base_name("旅行照片.jpeg"), "旅行照片");
        assert_eq!(pasted_image_base_name("my:photo?.png"), "my-photo-");
        assert_eq!(pasted_image_base_name("CON.png"), "image-CON");
    }

    #[test]
    fn writes_beside_note_and_suffixes_collisions() {
        let directory = std::env::temp_dir().join(format!(
            "inkfellow-paste-image-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let note = directory.join("note.md");
        fs::write(&note, b"# Test\n").unwrap();
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

        let first = write_pasted_image_file(&note, "note.md", "image-20260716-120000", "png", &png)
            .unwrap();
        let second =
            write_pasted_image_file(&note, "note.md", "image-20260716-120000", "png", &png)
                .unwrap();

        assert_eq!(first.name, "image-20260716-120000.png");
        assert_eq!(first.path, "image-20260716-120000.png");
        assert_eq!(second.name, "image-20260716-120000-2.png");
        assert!(directory.join(&first.name).is_file());
        assert!(directory.join(&second.name).is_file());

        fs::remove_dir_all(directory).unwrap();
    }
}
