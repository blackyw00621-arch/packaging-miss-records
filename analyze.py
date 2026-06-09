import psycopg2
import psycopg2.extras

conn_str = 'postgresql://postgres.knbeomtsuvvvyoacnkbf:3c2yQFOvECbig3Tq@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres'
conn = psycopg2.connect(conn_str)
cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

# ── 欄位結構 ──────────────────────────────────────
print("=== hr_miss_record_types 欄位結構 ===")
cur.execute("""
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'hr_miss_record_types'
    ORDER BY ordinal_position
""")
for row in cur.fetchall():
    print(dict(row))

print()
print("=== hr_miss_records 欄位結構 ===")
cur.execute("""
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name = 'hr_miss_records'
    ORDER BY ordinal_position
""")
for row in cur.fetchall():
    print(dict(row))

# ── hr_miss_record_types 全量 ─────────────────────
print()
print("=== hr_miss_record_types 全量資料 ===")
cur.execute("SELECT * FROM hr_miss_record_types ORDER BY id")
types_rows = cur.fetchall()
for row in types_rows:
    print(dict(row))
type_ids = {row['id'] for row in types_rows}

# ── hr_miss_records 總筆數 ─────────────────────────
cur.execute("SELECT COUNT(*) AS total FROM hr_miss_records")
total = cur.fetchone()['total']
print()
print(f"=== hr_miss_records 總筆數: {total} ===")

# ── 1. 最常被記的事項 ──────────────────────────────
print()
print("=== 1. 最常記的事項 (依 miss_type_id + subcategory 分組) ===")
cur.execute("""
    SELECT r.miss_type_id, r.category, r.subcategory, COUNT(*) AS cnt
    FROM hr_miss_records r
    GROUP BY r.miss_type_id, r.category, r.subcategory
    ORDER BY cnt DESC
""")
for row in cur.fetchall():
    print(dict(row))

# ── 2. 被記最多的組員 ─────────────────────────────
print()
print("=== 2. 被記最多的組員 (Top 20) ===")
cur.execute("""
    SELECT employee_id, employee_name, employee_code, employee_position, COUNT(*) AS cnt
    FROM hr_miss_records
    GROUP BY employee_id, employee_name, employee_code, employee_position
    ORDER BY cnt DESC
    LIMIT 20
""")
for row in cur.fetchall():
    print(dict(row))

# ── 3. record_types 使用狀況 ──────────────────────
print()
print("=== 3. hr_miss_record_types 使用狀況 (join 計算) ===")
cur.execute("""
    SELECT t.id, t.item_code, t.category, t.subcategory, t.jobs, COUNT(r.id) AS usage_count
    FROM hr_miss_record_types t
    LEFT JOIN hr_miss_records r ON r.miss_type_id = t.id
    GROUP BY t.id, t.item_code, t.category, t.subcategory, t.jobs
    ORDER BY usage_count DESC
""")
for row in cur.fetchall():
    print(dict(row))

# ── 4. hr_miss_records 裡用到但 types 不存在的 id ─
print()
print("=== 4. hr_miss_records 中孤兒 miss_type_id (不存在於 types 表) ===")
cur.execute("""
    SELECT DISTINCT r.miss_type_id
    FROM hr_miss_records r
    LEFT JOIN hr_miss_record_types t ON t.id = r.miss_type_id
    WHERE t.id IS NULL
""")
orphans = cur.fetchall()
if orphans:
    for row in orphans:
        print(dict(row))
else:
    print("無孤兒資料，FK 一致")

# ── 5. types 表有無重複 name ─────────────────────
print()
print("=== 5. hr_miss_record_types 重複名稱檢查 ===")
cur.execute("""
    SELECT name, COUNT(*) AS cnt
    FROM hr_miss_record_types
    GROUP BY name
    HAVING COUNT(*) > 1
""")
dupes = cur.fetchall()
if dupes:
    for row in dupes:
        print(dict(row))
else:
    print("無重複名稱")

cur.close()
conn.close()
print()
print("Done.")
