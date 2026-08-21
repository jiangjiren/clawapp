use base64::{engine::general_purpose, Engine as _};
use notify::{
    Config as NotifyConfig, Event as NotifyEvent, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
    mpsc, Mutex,
};
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
    transient_vault_path: Mutex<Option<PathBuf>>,
    pending_markdown_files: Mutex<Vec<PathBuf>>,
    initial_vault_services_deferred: AtomicBool,
    vault_services_generation: AtomicU64,
    vault_services_ready_generation: AtomicU64,
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
    #[serde(rename = "transientVault")]
    transient_vault: bool,
}

#[derive(Serialize)]
struct OpenMarkdownResponse {
    desktop: DesktopState,
    path: String,
    note: NoteResponse,
    #[serde(rename = "rootChanged")]
    root_changed: bool,
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

fn canonical_markdown_file(value: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(value).map_err(|_| "Markdown file not found.".to_string())?;
    if !canonical.is_file() {
        return Err("The selected path is not a file.".to_string());
    }
    if path_extension(&canonical) != "md" {
        return Err("Only Markdown (.md) files can be opened this way.".to_string());
    }
    Ok(canonical)
}

fn markdown_files_from_args(args: impl IntoIterator<Item = OsString>, cwd: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for argument in args {
        let path = PathBuf::from(argument);
        let candidate = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let Ok(canonical) = canonical_markdown_file(&candidate) else {
            continue;
        };
        if !files.contains(&canonical) {
            files.push(canonical);
        }
    }
    files
}

fn enqueue_pending_markdown_files(app: &AppHandle, files: Vec<PathBuf>) {
    if files.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let mut pending = state
        .pending_markdown_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for path in files {
        if !pending.contains(&path) {
            pending.push(path);
        }
    }
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

fn transient_vault_path(app: &AppHandle) -> Option<PathBuf> {
    app.state::<AppState>()
        .transient_vault_path
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn set_transient_vault_path(app: &AppHandle, path: Option<PathBuf>) {
    *app.state::<AppState>()
        .transient_vault_path
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
}

fn is_transient_vault(app: &AppHandle) -> bool {
    transient_vault_path(app).is_some()
}

fn ensure_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = transient_vault_path(app) {
        return Ok(path);
    }

    if let Some(path) = get_saved_vault_path(app) {
        fs::create_dir_all(&path).map_err(|err| err.to_string())?;
        return Ok(path);
    }

    let path = default_vault_path(app);
    fs::create_dir_all(&path).map_err(|err| err.to_string())?;
    save_vault_path(app, &path)?;
    Ok(path)
}

fn persistent_vault_path(app: &AppHandle) -> Result<PathBuf, String> {
    if is_transient_vault(app) {
        return Err(
            "Temporary Markdown files are not part of a sync workspace. Choose a notes folder first."
                .to_string(),
        );
    }
    ensure_vault_path(app)
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

fn vault_services_ready(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    state.vault_services_generation.load(AtomicOrdering::SeqCst)
        == state
            .vault_services_ready_generation
            .load(AtomicOrdering::SeqCst)
}

fn begin_vault_services_restart(app: &AppHandle) -> u64 {
    app.state::<AppState>()
        .vault_services_generation
        .fetch_add(1, AtomicOrdering::SeqCst)
        + 1
}

fn finish_vault_services_restart(app: &AppHandle, generation: u64) {
    let state = app.state::<AppState>();
    if state.vault_services_generation.load(AtomicOrdering::SeqCst) == generation {
        state
            .vault_services_ready_generation
            .store(generation, AtomicOrdering::SeqCst);
    }
}

fn restart_vault_services_in_background(app: &AppHandle, root: PathBuf) {
    let generation = begin_vault_services_restart(app);
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if vault_root(&handle).ok().as_ref() != Some(&root) {
            return;
        }
        if let Err(err) = start_vault_watcher(&handle) {
            eprintln!("[inkfellow] vault watcher failed: {err}");
        }
        if vault_root(&handle).ok().as_ref() != Some(&root) {
            return;
        }
        restart_agent(&handle);
        if vault_root(&handle).ok().as_ref() == Some(&root) {
            finish_vault_services_restart(&handle, generation);
        }
    });
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

            // 未合并（冲突）路径的两个字符都非空且至少一个是 U，或是 AA/DD——
            // 必须在普通 added/deleted 判断之前拦截，否则会被误标成"modified"，
            // 导致带冲突标记的文本被当成正常改动提交推送出去。
            let is_conflict =
                code.len() == 2 && (code.contains('U') || code == "AA" || code == "DD");

            let (state, path) = if raw_path.contains(" -> ") {
                ("renamed", raw_path.split(" -> ").last().unwrap_or(raw_path))
            } else if is_conflict {
                ("conflict", raw_path)
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
        agent_ready: vault_services_ready(&app) && agent_ready(port),
        agent_token: state.agent_token.clone(),
        transient_vault: is_transient_vault(&app),
    })
}

#[tauri::command]
fn take_pending_markdown_files(app: AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let mut pending = state
        .pending_markdown_files
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    pending
        .drain(..)
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn agent_status(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    Ok(vault_services_ready(&app) && agent_ready(state.claude_port))
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
    set_transient_vault_path(&app, None);
    allow_vault_assets(&app, &path)?;
    ensure_git_repo(&path);
    let generation = begin_vault_services_restart(&app);
    if let Err(err) = start_vault_watcher(&app) {
        eprintln!("[inkfellow] vault watcher failed: {err}");
    }
    restart_agent(&app);
    finish_vault_services_restart(&app, generation);
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
    set_transient_vault_path(&app, None);
    allow_vault_assets(&app, &path_buf)?;
    ensure_git_repo(&path_buf);
    let generation = begin_vault_services_restart(&app);
    if let Err(err) = start_vault_watcher(&app) {
        eprintln!("[inkfellow] vault watcher failed: {err}");
    }
    restart_agent(&app);
    finish_vault_services_restart(&app, generation);
    get_desktop_state(app).await
}

#[tauri::command]
async fn open_markdown_file(app: AppHandle, path: String) -> Result<OpenMarkdownResponse, String> {
    let markdown = canonical_markdown_file(Path::new(&path))?;
    let previous_root = vault_root(&app).ok();
    let saved_root = get_saved_vault_path(&app).and_then(|saved| fs::canonicalize(saved).ok());

    let (root, transient) = match saved_root {
        Some(saved) if markdown.starts_with(&saved) => (saved, false),
        _ => (
            markdown
                .parent()
                .ok_or_else(|| "Markdown file has no parent folder.".to_string())?
                .to_path_buf(),
            true,
        ),
    };
    let relative = markdown
        .strip_prefix(&root)
        .map(to_slash_path)
        .map_err(|_| "Markdown file is outside the selected folder.".to_string())?;

    allow_vault_assets(&app, &root)?;
    set_transient_vault_path(&app, transient.then_some(root.clone()));

    let root_changed = previous_root.as_ref() != Some(&root);
    let initial_services_deferred = app
        .state::<AppState>()
        .initial_vault_services_deferred
        .swap(false, AtomicOrdering::SeqCst);
    let note = read_note(app.clone(), relative.clone()).await?;
    if root_changed || initial_services_deferred {
        restart_vault_services_in_background(&app, root);
    }

    Ok(OpenMarkdownResponse {
        desktop: get_desktop_state(app).await?,
        path: relative,
        note,
        root_changed,
    })
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

/// 清掉上一次遗留的未完成 rebase/merge（比如老版本卡在 rebase 冲突里、或者上次
/// 异常退出），保证每次 pull 前仓库处于可操作状态。冲突文件本身已经在
/// pull 失败时被自动合并保留，这里只是防止仓库卡死，不会丢内容。
fn abort_stale_merge(path: &Path) {
    if path.join(".git/rebase-merge").exists() || path.join(".git/rebase-apply").exists() {
        let _ = run_git(path, &["rebase", "--abort"]);
    }
    if path.join(".git/MERGE_HEAD").exists() {
        let _ = run_git(path, &["merge", "--abort"]);
    }
}

/// 冲突路径 + ours（stage 2）blob + theirs（stage 3）blob；某一侧为 None 表示该侧删除了这个文件。
type ConflictEntry = (String, Option<String>, Option<String>);

/// 列出未合并（冲突）路径及其 ours/theirs blob。
fn list_conflicted_files(path: &Path) -> Result<Vec<ConflictEntry>, String> {
    let out = run_git(path, &["ls-files", "-u"])?;
    let mut result: Vec<ConflictEntry> = Vec::new();
    for line in out.stdout.lines() {
        let mut parts = line.splitn(2, '\t');
        let meta = parts.next().unwrap_or("");
        let Some(file) = parts.next().filter(|f| !f.is_empty()) else {
            continue;
        };
        let mut cols = meta.split_whitespace();
        let _mode = cols.next();
        let blob = cols.next().unwrap_or("").to_string();
        let stage = cols.next().unwrap_or("");
        let rel_path = unquote_git_path(file).replace('\\', "/");

        match result.iter_mut().find(|(p, _, _)| *p == rel_path) {
            Some((_, ours, theirs)) => {
                if stage == "2" {
                    *ours = Some(blob);
                } else if stage == "3" {
                    *theirs = Some(blob);
                }
            }
            None => {
                let mut ours = None;
                let mut theirs = None;
                if stage == "2" {
                    ours = Some(blob);
                } else if stage == "3" {
                    theirs = Some(blob);
                }
                result.push((rel_path, ours, theirs));
            }
        }
    }
    Ok(result)
}

/// 读取 git 对象的原始字节（不做 UTF-8 有损转换），保证图片等二进制冲突文件也能安全还原。
fn run_git_bytes(path: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let _guard = GIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut command = Command::new("git");
    command.arg("-C").arg(path);
    command.arg("-c").arg("core.quotepath=false");
    for arg in args {
        command.arg(arg);
    }
    hide_command_window(&mut command);
    let output = command.output().map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(output.stdout)
}

/// 生成一个不会覆盖现有文件的冲突备份路径：与原笔记同目录，文件名带时间戳。
fn conflict_backup_path(root: &Path, relative_path: &str) -> PathBuf {
    let rel = relative_to_path_buf(relative_path);
    let parent = rel.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = rel
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or("笔记")
        .to_string();
    let ext = rel
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_string();
    let ts = format_unix_secs_utc(now_secs());

    let mut counter = 0u32;
    loop {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!(" ({})", counter + 1)
        };
        let file_name = if ext.is_empty() {
            format!("{stem} (本地冲突备份 {ts}){suffix}")
        } else {
            format!("{stem} (本地冲突备份 {ts}){suffix}.{ext}")
        };
        let candidate_rel = parent.join(&file_name);
        if !root.join(&candidate_rel).exists() {
            return candidate_rel;
        }
        counter += 1;
    }
}

fn write_conflict_backup(root: &Path, backup_rel: &Path, bytes: &[u8]) -> Result<(), String> {
    let abs = root.join(backup_rel);
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(abs, bytes).map_err(|err| err.to_string())
}

/// UTC 日期时间字符串（YYYYMMDD-HHMMSS），只用于生成人类可读的备份文件名，
/// 没有引入额外的时间处理依赖。算法见 Howard Hinnant 的 civil_from_days。
fn format_unix_secs_utc(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}{mo:02}{d:02}-{h:02}{m:02}{s:02}")
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// 云端和本地都改过同一批文件时的自动合并：以云端版本为准写回原路径，
/// 本地版本（如果内容不同）另存成一份备份笔记，绝不静默丢弃任何一侧的内容。
/// 这一步只有在 pull 真的产生了未合并路径时才会被调用。
fn auto_resolve_merge_conflicts(
    path: &Path,
    conflicts: Vec<ConflictEntry>,
) -> Result<String, String> {
    if conflicts.is_empty() {
        return Err("未找到冲突文件".to_string());
    }

    // 两种冲突来源的 ours/theirs 含义正好相反，必须先分清楚是哪一种：
    //
    // 1) 真正的分支合并冲突（存在 MERGE_HEAD）：ours=本地、theirs=云端，语义符合直觉。
    // 2) pull 用的是 `--autostash`：如果 pull 本身是快进（没有需要合并的本地提交），
    //    HEAD 会先快进到云端，冲突其实发生在"重新套用 autostash"这一步——这时
    //    ls-files 报的 stage2(ours) 其实是已经快进过去的云端内容，stage3(theirs)
    //    才是被重新套用、和云端冲突的本地暂存改动。这种情况下没有 MERGE_HEAD，
    //    但会在 stash 列表里留一条记录，处理完要把它清掉，避免堆积。
    let merging = path.join(".git").join("MERGE_HEAD").exists();
    let stash_list = run_git(path, &["stash", "list"]).ok();
    let has_autostash = stash_list
        .as_ref()
        .map(|out| {
            out.stdout
                .lines()
                .next()
                .unwrap_or("")
                .to_lowercase()
                .contains("autostash")
        })
        .unwrap_or(false);

    let mut backups: Vec<String> = Vec::new();
    for (rel_path, ours_blob, theirs_blob) in &conflicts {
        let abs_path = path.join(relative_to_path_buf(rel_path));
        let (cloud_blob, local_blob) = if merging {
            (theirs_blob.clone(), ours_blob.clone())
        } else {
            (ours_blob.clone(), theirs_blob.clone())
        };
        match cloud_blob {
            Some(cloud) => {
                let cloud_bytes = run_git_bytes(path, &["cat-file", "-p", &cloud])?;
                if let Some(local) = local_blob {
                    let local_bytes = run_git_bytes(path, &["cat-file", "-p", &local])?;
                    if local_bytes != cloud_bytes {
                        let backup_rel = conflict_backup_path(path, rel_path);
                        write_conflict_backup(path, &backup_rel, &local_bytes)?;
                        backups.push(to_slash_path(&backup_rel));
                    }
                }
                if let Some(parent) = abs_path.parent() {
                    fs::create_dir_all(parent).map_err(|err| err.to_string())?;
                }
                fs::write(&abs_path, &cloud_bytes).map_err(|err| err.to_string())?;
            }
            None => {
                // 云端删除了这个文件：本地内容（如果还在）另存为备份，原路径跟随云端删除。
                if let Some(local) = local_blob {
                    let local_bytes = run_git_bytes(path, &["cat-file", "-p", &local])?;
                    let backup_rel = conflict_backup_path(path, rel_path);
                    write_conflict_backup(path, &backup_rel, &local_bytes)?;
                    backups.push(to_slash_path(&backup_rel));
                }
                let _ = fs::remove_file(&abs_path);
            }
        }
    }

    let count = conflicts.len();
    let commit_message = format!("自动合并：{count} 篇笔记本地与云端同时修改，已自动合并");
    let commit = do_git_commit(path, &commit_message)?;
    if !commit.success {
        return Err(if commit.stderr.trim().is_empty() {
            commit.stdout
        } else {
            commit.stderr
        });
    }

    if has_autostash {
        let _ = run_git(path, &["stash", "drop", "stash@{0}"]);
    }

    Ok(if backups.is_empty() {
        format!("云端和本地有 {count} 篇笔记同时修改，内容一致，已自动合并。")
    } else {
        format!(
            "云端和本地有 {count} 篇笔记同时修改，已自动合并并保留本地版本备份：{}",
            backups.join("、")
        )
    })
}

fn do_git_pull(path: &Path) -> Result<GitOutput, String> {
    abort_stale_merge(path);
    let pull = run_git(path, &["pull", "--no-rebase", "--autostash"])?;
    let conflicts = list_conflicted_files(path)?;
    if conflicts.is_empty() {
        return Ok(pull);
    }
    match auto_resolve_merge_conflicts(path, conflicts) {
        Ok(summary) => Ok(GitOutput {
            success: true,
            stdout: summary,
            stderr: String::new(),
            code: Some(0),
        }),
        Err(err) => {
            abort_stale_merge(path);
            Ok(GitOutput {
                success: false,
                stdout: pull.stdout,
                stderr: format!("自动合并冲突失败：{err}；请检查磁盘空间或权限后重试"),
                code: pull.code,
            })
        }
    }
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
    /// network | auth | other，前端据此显示对应的人话文案，不再把原始 git 报错甩给用户
    error_kind: Option<String>,
    status: Option<GitStatus>,
}

/// 把 git 的原始英文报错归类成前端能理解的粗粒度错误类型。
/// 冲突已经在 do_git_pull 里自动合并掉了，这里只覆盖网络/鉴权/其它三类。
fn classify_git_error(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    const NETWORK_PATTERNS: &[&str] = &[
        "could not resolve host",
        "could not resolve proxy",
        "failed to connect",
        "connection timed out",
        "connection refused",
        "network is unreachable",
        "recv failure",
        "send failure",
        "ssl connect error",
        "operation timed out",
        "could not connect to server",
        "the requested url returned error: 5",
    ];
    const AUTH_PATTERNS: &[&str] = &[
        "authentication failed",
        "permission denied",
        "could not read username",
        "could not read password",
        "invalid username or password",
        "the requested url returned error: 401",
        "the requested url returned error: 403",
        "please make sure you have the correct access rights",
        "terminal prompts disabled",
    ];
    if NETWORK_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
    {
        "network"
    } else if AUTH_PATTERNS.iter().any(|pattern| lower.contains(pattern)) {
        "auth"
    } else {
        "other"
    }
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
    let status = persistent_vault_path(app)
        .and_then(|path| compute_git_status(&path))
        .ok();
    let error_kind = error
        .as_deref()
        .map(|msg| classify_git_error(msg).to_string());
    emit_sync(
        app,
        SyncEvent {
            phase: "idle".to_string(),
            kind: kind.to_string(),
            pulled_changes: pulled,
            feedback,
            error,
            error_kind,
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
            error_kind: None,
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
        let Ok(vault) = persistent_vault_path(&app) else {
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
    persistent_vault_path(app)?;
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
    if is_transient_vault(&app) {
        return Ok(GitStatus {
            initialized: false,
            clean: true,
            branch: None,
            ahead: 0,
            behind: 0,
            entries: Vec::new(),
            files: Vec::new(),
            last_sync: None,
            raw: "Temporary Markdown files are not part of a sync workspace.".to_string(),
        });
    }
    let path = persistent_vault_path(&app)?;
    compute_git_status(&path)
}

#[tauri::command]
async fn git_init(app: AppHandle) -> Result<GitOutput, String> {
    let path = persistent_vault_path(&app)?;
    run_git(&path, &["init"])
}

#[tauri::command]
async fn git_pull(app: AppHandle) -> Result<GitOutput, String> {
    let path = persistent_vault_path(&app)?;
    do_git_pull(&path)
}

#[tauri::command]
async fn git_push(app: AppHandle) -> Result<GitOutput, String> {
    let path = persistent_vault_path(&app)?;
    do_git_push(&path)
}

#[tauri::command]
async fn git_commit(app: AppHandle, message: String) -> Result<GitOutput, String> {
    let path = persistent_vault_path(&app)?;
    do_git_commit(&path, &message)
}

#[tauri::command]
async fn git_commit_and_push(app: AppHandle, message: String) -> Result<Vec<GitOutput>, String> {
    let path = persistent_vault_path(&app)?;
    let commit = do_git_commit(&path, &message)?;
    if !commit.success {
        return Ok(vec![commit]);
    }
    let push = do_git_push(&path)?;
    Ok(vec![commit, push])
}

#[tauri::command]
async fn git_history(app: AppHandle) -> Result<Vec<GitCommitRecord>, String> {
    let path = persistent_vault_path(&app)?;
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
    let root = persistent_vault_path(&app)?;
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
    let root = persistent_vault_path(&app)?;
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
    let startup_cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let startup_markdown_files = markdown_files_from_args(std::env::args_os(), &startup_cwd);
    let defer_initial_vault_services = !startup_markdown_files.is_empty();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let markdown_files =
                markdown_files_from_args(args.into_iter().map(OsString::from), Path::new(&cwd));
            if !markdown_files.is_empty() {
                enqueue_pending_markdown_files(app, markdown_files);
                let _ = app.emit("open-markdown-files-pending", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
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
            transient_vault_path: Mutex::new(None),
            pending_markdown_files: Mutex::new(startup_markdown_files),
            initial_vault_services_deferred: AtomicBool::new(defer_initial_vault_services),
            vault_services_generation: AtomicU64::new(0),
            vault_services_ready_generation: AtomicU64::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            get_desktop_state,
            take_pending_markdown_files,
            agent_status,
            select_and_set_vault,
            set_vault_path,
            open_markdown_file,
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
            let defer_vault_services = handle
                .state::<AppState>()
                .initial_vault_services_deferred
                .load(AtomicOrdering::SeqCst);
            if !defer_vault_services {
                if let Ok(vault) = ensure_vault_path(&handle) {
                    if let Err(err) = allow_vault_assets(&handle, &vault) {
                        eprintln!("[inkfellow] HTML asset scope setup failed: {err}");
                    }
                    ensure_git_repo(&vault);
                }
                if let Err(err) = start_vault_watcher(&handle) {
                    eprintln!("[inkfellow] vault watcher failed: {err}");
                }
                spawn_agent(&handle);
            }
            start_sync_worker(&handle);
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
mod markdown_open_tests {
    use super::*;

    #[test]
    fn collects_existing_markdown_arguments_and_ignores_other_values() {
        let directory = std::env::temp_dir().join(format!(
            "inkfellow-markdown-open-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let markdown = directory.join("带 空格的笔记.MD");
        let text = directory.join("note.txt");
        fs::write(&markdown, b"# Test\n").unwrap();
        fs::write(&text, b"not markdown").unwrap();

        let files = markdown_files_from_args(
            vec![
                OsString::from("带 空格的笔记.MD"),
                markdown.clone().into_os_string(),
                text.into_os_string(),
                OsString::from("--flag"),
            ],
            &directory,
        );

        assert_eq!(files, vec![fs::canonicalize(&markdown).unwrap()]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_directories_and_missing_markdown_files() {
        let directory = std::env::temp_dir().join(format!(
            "inkfellow-markdown-open-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();

        assert!(canonical_markdown_file(&directory).is_err());
        assert!(canonical_markdown_file(&directory.join("missing.md")).is_err());
        fs::remove_dir_all(directory).unwrap();
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

#[cfg(test)]
mod sync_conflict_tests {
    use super::*;

    fn unique_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("inkfellow-{label}-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn configure_identity(repo: &Path, name: &str) {
        run_git(
            repo,
            &["config", "user.email", &format!("{name}@example.com")],
        )
        .unwrap();
        run_git(repo, &["config", "user.name", name]).unwrap();
        // 关掉本机全局的 autocrlf，避免测试断言被行尾转换干扰（生产逻辑本身不关心行尾）。
        run_git(repo, &["config", "core.autocrlf", "false"]).unwrap();
    }

    /// 建一个裸仓库当云端，克隆出两个工作区 a/b，模拟两台设备各自同步。
    fn setup_remote_pair() -> (PathBuf, PathBuf, PathBuf) {
        let base = unique_dir("sync-conflict");
        let remote = base.join("remote");
        let a = base.join("a");
        fs::create_dir_all(&remote).unwrap();
        fs::create_dir_all(&a).unwrap();

        run_git(&remote, &["init", "--bare"]).unwrap();
        run_git(&a, &["init"]).unwrap();
        run_git(&a, &["checkout", "-b", "master"]).unwrap();
        configure_identity(&a, "device-a");
        run_git(&a, &["remote", "add", "origin", remote.to_str().unwrap()]).unwrap();
        fs::write(a.join("note.md"), "line1\nline2\n").unwrap();
        run_git(&a, &["add", "-A"]).unwrap();
        run_git(&a, &["commit", "-m", "init"]).unwrap();
        run_git(&a, &["push", "-u", "origin", "master"]).unwrap();

        let b = base.join("b");
        // 关键：autocrlf=false 必须在 clone 的时候就生效（用 -c 传给 clone 本身），
        // 不然本机全局 autocrlf=true 会在首次检出时把工作区转成 CRLF，
        // 而索引里存的还是 LF——两者不一致会被 git 当成"脏改"，
        // 导致后面的 pull 无中生有触发一次假冲突，干扰测试断言。
        let clone_output = Command::new("git")
            .arg("-c")
            .arg("core.autocrlf=false")
            .arg("clone")
            .arg("-b")
            .arg("master")
            .arg(&remote)
            .arg(&b)
            .output()
            .unwrap();
        assert!(clone_output.status.success());
        configure_identity(&b, "device-b");

        (base, a, b)
    }

    #[test]
    fn auto_resolves_dirty_pull_conflict_without_losing_either_side() {
        // 复现真实场景：本地笔记还没提交就被改动，这时触发同步——commitPush 任务
        // 会先 pull（工作区是脏的），如果远端也改了同一处，autostash 重新套用时
        // 会冲突，且 `git pull` 本身可能仍然返回成功退出码。回归前，这种冲突文本
        // 会被当成正常内容直接 commit + push，污染笔记内容。
        let (base, a, b) = setup_remote_pair();

        fs::write(a.join("note.md"), "line1 EDITED BY A\nline2\n").unwrap();
        run_git(&a, &["add", "-A"]).unwrap();
        run_git(&a, &["commit", "-m", "A edits"]).unwrap();
        run_git(&a, &["push", "origin", "master"]).unwrap();

        // b 端：脏改（不提交），随后触发同步引擎实际使用的 do_git_pull。
        fs::write(&b.join("note.md"), "line1\nline2 EDITED BY B UNCOMMITTED\n").unwrap();

        let result = do_git_pull(&b).unwrap();
        assert!(
            result.success,
            "pull should self-heal instead of failing: {:?}",
            result.stderr
        );

        // 冲突标记不能出现在最终文件里。
        let final_content = fs::read_to_string(b.join("note.md")).unwrap();
        assert!(!final_content.contains("<<<<<<<"));
        assert!(!final_content.contains(">>>>>>>"));
        assert_eq!(final_content, "line1 EDITED BY A\nline2\n");

        // 本地版本必须被保留成一份备份笔记，而不是静默丢弃。
        let backup = fs::read_dir(&b)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().contains("本地冲突备份"))
            .expect("local version should be preserved as a backup file");
        let backup_content = fs::read_to_string(backup.path()).unwrap();
        assert_eq!(backup_content, "line1\nline2 EDITED BY B UNCOMMITTED\n");

        // 仓库必须回到干净、可继续同步的状态：没有残留 stash，没有未合并路径。
        let conflicts = list_conflicted_files(&b).unwrap();
        assert!(conflicts.is_empty());
        let stash = run_git(&b, &["stash", "list"]).unwrap();
        assert!(stash.stdout.trim().is_empty());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn auto_resolves_true_merge_conflict_between_two_committed_histories() {
        // 和上一条不同：这里两边都已经提交（分叉历史），pull 走的是真正的
        // 分支合并（会留下 MERGE_HEAD），ours/theirs 的含义和 autostash 场景相反，
        // 用来锁定 auto_resolve_merge_conflicts 里那个按 MERGE_HEAD 分支的判断没写反。
        let (base, a, b) = setup_remote_pair();

        fs::write(a.join("note.md"), "line1 EDITED BY A\nline2\n").unwrap();
        run_git(&a, &["add", "-A"]).unwrap();
        run_git(&a, &["commit", "-m", "A edits"]).unwrap();
        run_git(&a, &["push", "origin", "master"]).unwrap();

        // b 端提交了自己的改动（不是脏改），造成分叉历史 -> 真正的合并冲突。
        fs::write(b.join("note.md"), "line1\nline2 EDITED BY B COMMITTED\n").unwrap();
        run_git(&b, &["add", "-A"]).unwrap();
        run_git(&b, &["commit", "-m", "B edits"]).unwrap();

        let result = do_git_pull(&b).unwrap();
        assert!(
            result.success,
            "pull should self-heal instead of failing: {:?}",
            result.stderr
        );

        let final_content = fs::read_to_string(b.join("note.md")).unwrap();
        assert!(!final_content.contains("<<<<<<<"));
        assert_eq!(final_content, "line1 EDITED BY A\nline2\n");

        let backup = fs::read_dir(&b)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().contains("本地冲突备份"))
            .expect("local version should be preserved as a backup file");
        assert_eq!(
            fs::read_to_string(backup.path()).unwrap(),
            "line1\nline2 EDITED BY B COMMITTED\n"
        );

        assert!(list_conflicted_files(&b).unwrap().is_empty());
        assert!(!b.join(".git").join("MERGE_HEAD").exists());

        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pull_without_conflict_still_succeeds_normally() {
        let (base, a, b) = setup_remote_pair();

        fs::write(a.join("note.md"), "line1 EDITED BY A\nline2\n").unwrap();
        run_git(&a, &["add", "-A"]).unwrap();
        run_git(&a, &["commit", "-m", "A edits"]).unwrap();
        run_git(&a, &["push", "origin", "master"]).unwrap();

        let result = do_git_pull(&b).unwrap();
        assert!(result.success);
        assert_eq!(
            fs::read_to_string(b.join("note.md")).unwrap(),
            "line1 EDITED BY A\nline2\n"
        );

        fs::remove_dir_all(base).unwrap();
    }
}
