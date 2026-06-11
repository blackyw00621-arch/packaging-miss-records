from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import date
from typing import Any

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware


def load_dotenv(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


load_dotenv()

DB_URL = os.getenv("SUPABASE_URL")
if not DB_URL:
    raise RuntimeError("SUPABASE_URL not found. Please set it in .env")


app = FastAPI(title="Packaging Miss Records API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def db_cursor():
    conn = psycopg2.connect(DB_URL)
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        yield cur
    finally:
        conn.close()


def to_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return fallback


MAX_RANGE_DAYS = 92


def validate_date_range(start_date: str | None, end_date: str | None) -> None:
    if not start_date or not end_date:
        return
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {exc}")

    if end < start:
        raise HTTPException(status_code=400, detail="end_date must be greater than or equal to start_date")

    if (end - start).days > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail="Date range is limited to 3 months (92 days)")


def validate_month_range(start_month: str | None, end_month: str | None) -> None:
    if not start_month or not end_month:
        return
    try:
        start = date.fromisoformat(f"{start_month}-01")
        end = date.fromisoformat(f"{end_month}-01")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid month format: {exc}")

    if end < start:
        raise HTTPException(status_code=400, detail="end_month must be greater than or equal to start_month")

    months = (end.year - start.year) * 12 + (end.month - start.month)
    # Allow up to 3 months range; e.g. 2026-03 to 2026-06 should pass.
    if months > 3:
        raise HTTPException(status_code=400, detail="Month range is limited to 3 months")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def get_index():
    from fastapi.responses import FileResponse
    return FileResponse("index.html")


@app.get("/app.js")
def get_app_js():
    from fastapi.responses import FileResponse
    return FileResponse("app.js")


@app.get("/api/v1/types")
def get_types(
    jobs: str | None = Query(default=None),
    include_unused: bool = Query(default=True),
) -> dict[str, list[dict[str, Any]]]:
    sql = """
    SELECT
        t.id AS miss_type_id,
        t.item_code,
        t.jobs,
        t.category,
        t.subcategory,
        t.points,
        COUNT(r.id)::int AS usage_count
    FROM hr_miss_record_types t
    LEFT JOIN hr_miss_records r ON r.miss_type_id = t.id
    WHERE (
        %(jobs)s IS NULL
        OR t.jobs = %(jobs)s
        OR t.jobs LIKE %(jobs_like)s
    )
    GROUP BY t.id, t.item_code, t.jobs, t.category, t.subcategory, t.points
    ORDER BY t.id
    """

    with db_cursor() as cur:
        cur.execute(sql, {"jobs": jobs, "jobs_like": f"{jobs}%" if jobs else None})
        rows = cur.fetchall()

    items: list[dict[str, Any]] = []
    for row in rows:
        usage_count = to_int(row.get("usage_count"), 0)
        item = {
            "miss_type_id": to_int(row.get("miss_type_id")),
            "item_code": row.get("item_code"),
            "jobs": row.get("jobs"),
            "category": row.get("category"),
            "subcategory": row.get("subcategory"),
            "points": to_int(row.get("points"), 0),
            "usage_count": usage_count,
            "is_unused": usage_count == 0,
        }
        if include_unused or usage_count > 0:
            items.append(item)

    return {"items": items}


@app.get("/api/v1/types/jobs-summary")
def get_types_jobs_summary() -> dict[str, list[dict[str, Any]]]:
    sql = """
    SELECT
        t.jobs,
        COUNT(*)::int AS total_types,
        COUNT(*) FILTER (WHERE COALESCE(u.usage_count, 0) > 0)::int AS used_types,
        COUNT(*) FILTER (WHERE COALESCE(u.usage_count, 0) = 0)::int AS unused_types
    FROM hr_miss_record_types t
    LEFT JOIN (
        SELECT miss_type_id, COUNT(*)::int AS usage_count
        FROM hr_miss_records
        GROUP BY miss_type_id
    ) u ON u.miss_type_id = t.id
    GROUP BY t.jobs
    ORDER BY t.jobs
    """

    with db_cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    items = []
    for row in rows:
        job = str(row.get("jobs") or "")
        items.append(
            {
                "jobs": job,
                "label": f"{job} {'全員' if job == '0' else '組員' if job == '1' else '貼紙' if job == '2' else '品保' if job == '3' else '機台' if job == '4' else '其他'}",
                "total_types": to_int(row.get("total_types")),
                "used_types": to_int(row.get("used_types")),
                "unused_types": to_int(row.get("unused_types")),
            }
        )

    return {"items": items}


@app.get("/api/v1/stats/top-items")
def get_top_items(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    employee_position: str | None = Query(default=None),
    jobs: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, list[dict[str, Any]]]:
    validate_date_range(start_date, end_date)

    sql = """
    SELECT
        CASE
            WHEN t.item_code IN ('2貼紙-3', '2貼紙-4') THEN 'label_print_error'
            ELSE COALESCE(t.subcategory, r.subcategory, 'unknown')
        END AS group_key,
        CASE
            WHEN t.item_code IN ('2貼紙-3', '2貼紙-4') THEN '標籤印製錯誤'
            ELSE COALESCE(t.subcategory, r.subcategory, '未分類')
        END AS group_name,
        COUNT(*)::int AS count
    FROM hr_miss_records r
    LEFT JOIN hr_miss_record_types t ON t.id = r.miss_type_id
    WHERE (%(start_date)s IS NULL OR r.event_date >= %(start_date)s::date)
      AND (%(end_date)s IS NULL OR r.event_date <= %(end_date)s::date)
      AND (%(employee_position)s IS NULL OR r.employee_position = %(employee_position)s)
      AND (
          %(jobs)s IS NULL
          OR t.jobs = %(jobs)s
          OR t.jobs LIKE %(jobs_like)s
      )
    GROUP BY 1, 2
    ORDER BY count DESC
    LIMIT %(limit)s
    """

    params = {
        "start_date": start_date,
        "end_date": end_date,
        "employee_position": employee_position,
        "jobs": jobs,
        "limit": limit,
        "jobs_like": f"{jobs}%" if jobs else None,
    }

    with db_cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return {"items": [dict(r) for r in rows]}


@app.get("/api/v1/stats/top-employees")
def get_top_employees(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    employee_position: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, list[dict[str, Any]]]:
    validate_date_range(start_date, end_date)

    top_sql = """
    SELECT
                COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') AS employee_code,
                COALESCE(NULLIF(r.employee_name, ''), '未填') AS employee_name,
        COUNT(*)::int AS total_count
    FROM hr_miss_records r
    WHERE (%(start_date)s IS NULL OR r.event_date >= %(start_date)s::date)
      AND (%(end_date)s IS NULL OR r.event_date <= %(end_date)s::date)
      AND (%(employee_position)s IS NULL OR r.employee_position = %(employee_position)s)
        GROUP BY COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填'), COALESCE(NULLIF(r.employee_name, ''), '未填')
    ORDER BY total_count DESC
    LIMIT %(limit)s
    """

    detail_sql = """
    SELECT
                COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') AS employee_code,
        r.employee_position,
        COUNT(*)::int AS count
    FROM hr_miss_records r
        WHERE COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') = ANY(%(employee_codes)s)
      AND (%(start_date)s IS NULL OR r.event_date >= %(start_date)s::date)
      AND (%(end_date)s IS NULL OR r.event_date <= %(end_date)s::date)
      AND (%(employee_position)s IS NULL OR r.employee_position = %(employee_position)s)
        GROUP BY COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填'), r.employee_position
        ORDER BY employee_code, count DESC
    """

    params = {
        "start_date": start_date,
        "end_date": end_date,
        "employee_position": employee_position,
        "limit": limit,
    }

    with db_cursor() as cur:
        cur.execute(top_sql, params)
        top_rows = cur.fetchall()

        employee_codes = [str(r.get("employee_code") or "") for r in top_rows if r.get("employee_code")]
        breakdown_map: dict[str, list[dict[str, Any]]] = {}

        if employee_codes:
            cur.execute(
                detail_sql,
                {
                    "employee_codes": employee_codes,
                    "start_date": start_date,
                    "end_date": end_date,
                    "employee_position": employee_position,
                },
            )
            for row in cur.fetchall():
                code = str(row.get("employee_code") or "未填")
                breakdown_map.setdefault(code, []).append(
                    {
                        "employee_position": row.get("employee_position") or "未填",
                        "count": to_int(row.get("count")),
                    }
                )

    items = []
    for row in top_rows:
        code = str(row.get("employee_code") or "未填")
        items.append(
            {
                "employee_code": code,
                "employee_name": row.get("employee_name") or "未命名",
                "total_count": to_int(row.get("total_count")),
                "position_breakdown": breakdown_map.get(code, []),
            }
        )

    return {"items": items}


@app.get("/api/v1/stats/monthly-trend")
def get_monthly_trend(
    start_month: str | None = Query(default=None),
    end_month: str | None = Query(default=None),
    employee_position: str | None = Query(default=None),
    jobs: str | None = Query(default=None),
) -> dict[str, list[dict[str, Any]]]:
    validate_month_range(start_month, end_month)

    sql = """
    SELECT
        to_char(date_trunc('month', r.event_date), 'YYYY-MM') AS month,
        COUNT(*)::int AS count
    FROM hr_miss_records r
    LEFT JOIN hr_miss_record_types t ON t.id = r.miss_type_id
    WHERE (%(start_month)s IS NULL OR r.event_date >= (%(start_month)s || '-01')::date)
      AND (%(end_month)s IS NULL OR r.event_date < ((%(end_month)s || '-01')::date + INTERVAL '1 month'))
      AND (%(employee_position)s IS NULL OR r.employee_position = %(employee_position)s)
      AND (
          %(jobs)s IS NULL
          OR t.jobs = %(jobs)s
          OR t.jobs LIKE %(jobs_like)s
      )
    GROUP BY date_trunc('month', r.event_date)
    ORDER BY date_trunc('month', r.event_date)
    """

    params = {
        "start_month": start_month,
        "end_month": end_month,
        "employee_position": employee_position,
        "jobs": jobs,
        "jobs_like": f"{jobs}%" if jobs else None,
    }

    with db_cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return {"items": [dict(r) for r in rows]}


@app.get("/api/v1/employees")
def get_employees() -> dict[str, list[dict[str, Any]]]:
    sql = """
    SELECT employee_code, employee_name, latest_position FROM (
        SELECT DISTINCT ON (COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填'))
            COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') AS employee_code,
            COALESCE(NULLIF(r.employee_name, ''), '未填') AS employee_name,
            r.employee_position AS latest_position
        FROM hr_miss_records r
        ORDER BY COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填'), r.event_date DESC, r.id DESC
    ) sub
    ORDER BY employee_name
    """
    with db_cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()

    return {"items": [dict(r) for r in rows]}


@app.get("/api/v1/records")
def get_records(
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    employee_position: str | None = Query(default=None),
    jobs: str | None = Query(default=None),
    employee_code: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, list[dict[str, Any]]]:
    validate_date_range(start_date, end_date)

    sql = """
    SELECT
        r.id,
        r.event_date,
        r.employee_id,
        COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') AS employee_code,
        COALESCE(NULLIF(r.employee_name, ''), '未填') AS employee_name,
        r.employee_position,
        r.item_code,
        COALESCE(t.category, r.category, '未分類') AS category,
        COALESCE(t.subcategory, r.subcategory, '未分類') AS subcategory,
        COALESCE(t.points, r.points, 0)::int AS points,
        COALESCE(r.notes, '') AS notes
    FROM hr_miss_records r
    LEFT JOIN hr_miss_record_types t ON t.id = r.miss_type_id
    WHERE (%(start_date)s IS NULL OR r.event_date >= %(start_date)s::date)
      AND (%(end_date)s IS NULL OR r.event_date <= %(end_date)s::date)
      AND (%(employee_position)s IS NULL OR r.employee_position = %(employee_position)s)
      AND (
          %(jobs)s IS NULL
          OR t.jobs = %(jobs)s
          OR t.jobs LIKE %(jobs_like)s
      )
      AND (%(employee_code)s IS NULL OR COALESCE(NULLIF(r.employee_code, ''), r.employee_id::text, '未填') = %(employee_code)s)
    ORDER BY r.event_date DESC, r.id DESC
    LIMIT %(limit)s
    """

    params = {
        "start_date": start_date,
        "end_date": end_date,
        "employee_position": employee_position,
        "jobs": jobs,
        "jobs_like": f"{jobs}%" if jobs else None,
        "employee_code": employee_code,
        "limit": limit,
    }

    with db_cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return {"items": [dict(r) for r in rows]}

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("api_server:app", host="0.0.0.0", port=5178, reload=True)
