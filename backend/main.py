import os
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Header, status
from pydantic import BaseModel
import mysql.connector
from mysql.connector.pooling import MySQLConnectionPool
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Manga Translator Cache API")

# 数据库配置
db_config = {
    "host": os.getenv("DB_HOST", "localhost"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", "123456"),
    "database": os.getenv("DB_NAME", "manga_translator"),
    "charset": "utf8mb4",
}

# API 密钥（可留空表示不验证）
API_KEY = os.getenv("API_KEY", "")

# 连接池
pool = MySQLConnectionPool(pool_name="manga_pool", pool_size=5, **db_config)


def init_db():
    """自动建表（如果不存在）"""
    conn = pool.get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS translations (
            source_text TEXT NOT NULL,
            target_lang VARCHAR(20) NOT NULL,
            translated_text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (source_text(200), target_lang)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    """)
    conn.commit()
    cursor.close()
    conn.close()


init_db()


# 模型
class CacheItem(BaseModel):
    source_text: str
    target_lang: str


class CacheSetItem(CacheItem):
    translated_text: str


class CacheSetRequest(BaseModel):
    items: List[CacheSetItem]


# 密钥验证依赖
def verify_api_key(x_api_key: Optional[str] = Header(None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API Key"
        )


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.post("/cache/batch_get", dependencies=[])
async def batch_get_cache(items: List[CacheItem], x_api_key: Optional[str] = Header(None)):
    """
    批量查询缓存
    请求体: [{"source_text": "...", "target_lang": "zh"}, ...]
    返回: { "results": { "source_text::target_lang": "translated_text", ... } }
    """
    verify_api_key(x_api_key)

    if not items:
        return {"results": {}}

    conn = pool.get_connection()
    cursor = conn.cursor(dictionary=True)

    # 构建查询条件
    conditions = []
    params = []
    for item in items:
        conditions.append("(source_text = %s AND target_lang = %s)")
        params.extend([item.source_text, item.target_lang])

    query = f"SELECT source_text, target_lang, translated_text FROM translations WHERE {' OR '.join(conditions)}"
    cursor.execute(query, params)
    rows = cursor.fetchall()

    results = {}
    for row in rows:
        key = f"{row['source_text']}::{row['target_lang']}"
        results[key] = row['translated_text']

    cursor.close()
    conn.close()
    return {"results": results}


@app.post("/cache/batch_set", dependencies=[])
async def batch_set_cache(body: CacheSetRequest, x_api_key: Optional[str] = Header(None)):
    """
    批量存储翻译
    请求体: {"items": [{"source_text": "...", "target_lang": "...", "translated_text": "..."}]}
    """
    verify_api_key(x_api_key)

    if not body.items:
        return {"status": "ok"}

    conn = pool.get_connection()
    cursor = conn.cursor()

    for item in body.items:
        cursor.execute(
            "INSERT INTO translations (source_text, target_lang, translated_text) "
            "VALUES (%s, %s, %s) "
            "ON DUPLICATE KEY UPDATE translated_text = VALUES(translated_text)",
            (item.source_text, item.target_lang, item.translated_text)
        )

    conn.commit()
    cursor.close()
    conn.close()
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", 3000)))