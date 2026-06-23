fn main() {
    // Read API keys from the workspace .env at compile time and embed them
    // into the binary via cargo:rustc-env. This means release builds carry
    // the keys without any runtime file dependency. Only OPENAI_API_KEY and
    // GEMINI_API_KEY are forwarded; all other variables are ignored.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let env_candidates = [
        std::path::Path::new(&manifest_dir).join("../../../.env"),
        std::path::Path::new(&manifest_dir).join("../../../services/python-engine/.env"),
    ];
    let mut emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for env_path in &env_candidates {
        println!("cargo:rerun-if-changed={}", env_path.display());
        let Ok(content) = std::fs::read_to_string(env_path) else {
            continue;
        };
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            let Some((key, val)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim().to_string();
            let val = val.trim().trim_matches(['"', '\'']).to_string();
            if matches!(key.as_str(), "OPENAI_API_KEY" | "GEMINI_API_KEY")
                && !val.is_empty()
                && emitted.insert(key.clone())
            {
                println!("cargo:rustc-env={key}={val}");
            }
        }
    }
    tauri_build::build()
}
