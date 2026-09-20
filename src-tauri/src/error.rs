use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误：{0}")]
    Db(#[from] rusqlite::Error),
    #[error("网络请求失败：{0}")]
    Http(#[from] reqwest::Error),
    /// 用户在界面上按了「停止」。
    ///
    /// 单独一个变体而不是扔进 `Other`：前端要靠它区分"这次是我自己取消的"和"真出错了"，
    /// 否则停止之后还会弹一条红色的失败提示。
    #[error("已停止：这次查询被取消了。")]
    Cancelled,
    /// 整次查词超出设置的超时预算（秒）。
    #[error("请求超时：{0} 秒内没有拿到完整响应。可以在设置里调大「请求超时」，或点「停止」后重试。")]
    Timeout(u64),
    #[error("模型输出无法解析：{0}")]
    Parse(String),
    #[error("配置错误：{0}")]
    Config(String),
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Other(e.to_string())
    }
}

/// Tauri 命令的错误必须可序列化，前端才能拿到可读信息而不是 "unknown error"。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
