#!/usr/bin/env python3
"""廃棄物実測値：過去の実績CSV（現行システムのエクスポート）からの移行スクリプト。ローカル実行専用。

2026-09-09依頼。まずは今年度分（2026年4月〜8月）。

使い方:
    python3 scripts/import-waste-records-csv.py <csvパス> --from=2026-04-01 --to=2026-08-31 \
        [--emit-sql=<出力先.sql>]

  既定は解析と検証だけを行う（dry-run）。--emit-sql を付けると投入用SQLを書き出す。
  CSV・XMLはNodeの標準機能で読めるため他の移行スクリプトはNodeで書いているが、
  このCSVは1ファイルで完結し依存ライブラリも不要なため、古紙回収の移行スクリプトと
  同じdry-run→--emit-sqlの型に合わせてPythonで書いた。

CSV形式（ヘッダー）: 計量日付,１階,２階,３階,４階,５階,６階,７階,入力者選択,入力者,訂正メモ,作成日時,修正日時
  日付は「2026年4月1日」形式。階の列は空欄なら未計測（読み取れなかったマスと同じく
  行を作らない。waste-plan.md 3-3の「自動修正はしない」という考え方は移行データにも適用する）。
  入力者・訂正メモ・作成日時・修正日時は既存スキーマに対応する列が無いため取り込まない
  （実測値そのものより後から見て意味を持たない運用ログのため。依頼があれば別途 note 列等を検討）。

投入方針:
  過去に実際に計量・記録済みの確定値のため、source='manual' / is_confirmed=true として
  upsert する（Excel取込〈source='excel'〉と違い、確認待ちの下書きにはしない）。
  一意制約 (record_date, floor) に対して on conflict do update とし、再実行しても安全にする。
"""
import argparse
import csv
import re
import sys
from collections import defaultdict

FLOOR_COLUMNS = ['１階', '２階', '３階', '４階', '５階', '６階', '７階']
FLOOR_OF = {name: str(i + 1) for i, name in enumerate(FLOOR_COLUMNS)}

DATE_RE = re.compile(r'^(\d{4})年(\d{1,2})月(\d{1,2})日$')


def to_iso_date(s):
    m = DATE_RE.match(s.strip())
    if not m:
        return None
    y, mo, d = (int(g) for g in m.groups())
    return f'{y:04d}-{mo:02d}-{d:02d}'


def to_weight(v):
    v = (v or '').strip()
    if not v:
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    return round(n, 2) if n >= 0 else None


def parse_csv(path):
    records = []
    with open(path, encoding='utf-8-sig', newline='') as fp:
        reader = csv.DictReader(fp)
        missing = [c for c in ['計量日付', *FLOOR_COLUMNS] if c not in reader.fieldnames]
        if missing:
            sys.exit(f'想定と異なるヘッダーです。不足列: {missing} / 実際: {reader.fieldnames}')
        for row in reader:
            iso = to_iso_date(row['計量日付'])
            if not iso:
                print(f'  !! 日付を解釈できない行をスキップ: {row["計量日付"]!r}', file=sys.stderr)
                continue
            for col in FLOOR_COLUMNS:
                weight = to_weight(row.get(col))
                if weight is None:
                    continue
                records.append({'date': iso, 'floor': FLOOR_OF[col], 'weight_kg': weight})
    return records


def build_sql(records):
    """パイプ区切りの1行1レコードをPostgres側で分解する形にする（1文で入るように）。
    古紙回収の移行スクリプト（import-paper-records-xlsx.py）と同じ unnest 方式"""
    lines = [f"{r['date']}|{r['floor']}|{r['weight_kg']}" for r in records]
    return (
        "insert into waste_records (record_date, floor, weight_kg, source, is_confirmed)\n"
        "select split_part(t,'|',1)::date, split_part(t,'|',2), split_part(t,'|',3)::numeric,\n"
        "       'manual', true\n"
        "from unnest(string_to_array($D$\n" + '\n'.join(lines) +
        "\n$D$, E'\\n')) t\nwhere t <> ''\n"
        "on conflict (record_date, floor) do update\n"
        "  set weight_kg = excluded.weight_kg, source = excluded.source, is_confirmed = excluded.is_confirmed;\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('csv_path')
    ap.add_argument('--from', dest='date_from', required=True, help='YYYY-MM-DD（この日を含む）')
    ap.add_argument('--to', dest='date_to', required=True, help='YYYY-MM-DD（この日を含む）')
    ap.add_argument('--emit-sql', metavar='PATH', help='投入用SQLの出力先')
    args = ap.parse_args()

    all_records = parse_csv(args.csv_path)
    if not all_records:
        sys.exit('取り込める行がありませんでした')

    records = [r for r in all_records if args.date_from <= r['date'] <= args.date_to]
    print(f'CSV全体: {len(all_records)}件（{all_records[0]["date"]} 〜 {all_records[-1]["date"]}）')
    print(f'対象期間（{args.date_from} 〜 {args.date_to}）: {len(records)}件')
    if not records:
        sys.exit('指定期間に該当する行がありませんでした')

    by_floor_total = defaultdict(float)
    by_floor_count = defaultdict(int)
    for r in records:
        by_floor_total[r['floor']] += r['weight_kg']
        by_floor_count[r['floor']] += 1
    dates = sorted({r['date'] for r in records})
    print(f'対象日数: {len(dates)}日（{dates[0]} 〜 {dates[-1]}）')
    print('\n階  件数  合計kg')
    for f in sorted(by_floor_total):
        print(f'  {f}階  {by_floor_count[f]:>3}  {by_floor_total[f]:>8.2f}')
    print(f'  合計  {len(records):>3}  {sum(by_floor_total.values()):>8.2f}')

    extreme = [r for r in records if r['weight_kg'] >= 50]
    if extreme:
        print(f'\n異常値（50kg以上。書き間違いの疑い。参考表示のみ、移行自体は妨げない）: {len(extreme)}件')
        for r in extreme:
            print(f'  {r["date"]} {r["floor"]}階: {r["weight_kg"]}kg')

    if args.emit_sql:
        with open(args.emit_sql, 'w', encoding='utf-8') as fp:
            fp.write(build_sql(records))
        print(f'\nSQLを書き出しました: {args.emit_sql}')
    else:
        print('\n（dry-run。SQLを出すには --emit-sql=<パス> を付けてください）')


if __name__ == '__main__':
    main()
