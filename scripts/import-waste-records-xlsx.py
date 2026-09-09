#!/usr/bin/env python3
"""廃棄物実測値：月別シート形式のExcel（現行システムのエクスポート）からの移行スクリプト。
ローカル実行専用。

2026-09-09依頼。月ごとにシートが分かれた形式（シート名『１月』〜『１２月』、他に『祝日』
『年間集計』『ClarisStudioダウンロードデータ』を含む）から、指定した月だけを取り込む。

使い方:
    pip install openpyxl
    python3 scripts/import-waste-records-xlsx.py <xlsxパス> --sheets=１月,２月,...,８月 \
        [--emit-sql=<出力先.sql>]

  既定は解析・検証だけを行う（dry-run）。--emit-sql を付けると投入用SQLを書き出す。

シート形式（1月シートで確認。他の月も同一レイアウト）:
  1行目: タイトル・年（K列）・月（M/T列）等のメタ情報
  2〜3行目: 見出し（日・曜日・1F〜7F・合計）
  4行目〜: 1日1行。A列=日付、H〜N列=1〜7階の実測値、O列=合計（Excel側の計算値）
  最終行: F列が「合計」の列合計行

0とNoneの扱い（重要）: このExcelは値が無い（未計測）マスを空欄ではなく数式既定値の0で
埋めている。2025年12月分を過去に取り込んだCSV（現行システムの別エクスポート）と突き合わせた
ところ、CSV側で空欄だったマスが本Excelでは例外なくすべて0になっており、実測値としての0
（計量した結果ゼロだった）ではなく「未計測」を表す0だと確認できた。そのため0はNoneと同じ
「行を作らない」対象として扱う。

検証: 各シートの階ごとの値の合計が、シート内の「合計」行の値と一致することを確認する
（古紙回収の移行スクリプトと同じ、Excel側の計算値との突き合わせ）。
"""
import argparse
import sys
from collections import defaultdict
from datetime import date, datetime

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit('openpyxl が必要です: pip install openpyxl')

FLOOR_COLS = {8: '1', 9: '2', 10: '3', 11: '4', 12: '5', 13: '6', 14: '7'}  # H〜N列
TOTAL_COL = 15  # O列


def parse_sheet(ws, name):
    """1シート（1ヶ月分）を読み取る。戻り値は (records, per_floor_sheet_total)"""
    records = []
    totals_row = None
    for r in range(4, ws.max_row + 1):
        d = ws.cell(r, 1).value
        label = ws.cell(r, 6).value  # F列。合計行だけ「合計」の文字が入る
        if isinstance(label, str) and label.strip() == '合計':
            totals_row = r
            break
        if not isinstance(d, (datetime, date)):
            continue  # 日付が無い行（末尾の空行）はスキップ
        d = d.date() if isinstance(d, datetime) else d
        for col, floor in FLOOR_COLS.items():
            v = ws.cell(r, col).value
            if v is None or v == 0:
                continue  # 0は「未計測」（下記スクリプト冒頭の注記参照）
            records.append({'date': d.isoformat(), 'floor': floor, 'weight_kg': round(float(v), 2)})
    if totals_row is None:
        sys.exit(f'{name!r}: 合計行が見つかりませんでした')
    sheet_totals = {floor: ws.cell(totals_row, col).value or 0 for col, floor in FLOOR_COLS.items()}
    return records, sheet_totals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--sheets', required=True, help='カンマ区切りのシート名（例: １月,２月,...,８月）')
    ap.add_argument('--emit-sql', metavar='PATH', help='投入用SQLの出力先')
    args = ap.parse_args()

    wb = openpyxl.load_workbook(args.xlsx, data_only=True)
    sheet_names = [s.strip() for s in args.sheets.split(',')]
    missing = [s for s in sheet_names if s not in wb.sheetnames]
    if missing:
        sys.exit(f'シートが見つかりません: {missing} / 実際のシート一覧: {wb.sheetnames}')

    all_records = []
    for name in sheet_names:
        ws = wb[name]
        records, sheet_totals = parse_sheet(ws, name)
        computed = defaultdict(float)
        for rec in records:
            computed[rec['floor']] += rec['weight_kg']
        bad = [f for f in FLOOR_COLS.values()
               if abs(computed.get(f, 0) - float(sheet_totals.get(f, 0) or 0)) > 0.05]
        if bad:
            for f in bad:
                print(f'  !! 合計不一致 {name} {f}階: 自前={computed.get(f, 0):.2f} '
                      f'Excel={float(sheet_totals.get(f, 0) or 0):.2f}', file=sys.stderr)
            sys.exit(f'{name!r}: 階ごとの合計がExcel側の合計行と一致しません')
        print(f'{name!r}: {len(records)}行（合計チェックOK）')
        all_records.extend(records)

    if not all_records:
        sys.exit('取り込める行がありませんでした')

    dates = sorted({r['date'] for r in all_records})
    print(f'\n対象 {len(sheet_names)}シート: {len(all_records)}件（{dates[0]} 〜 {dates[-1]}）')

    by_floor_total = defaultdict(float)
    by_floor_count = defaultdict(int)
    for r in all_records:
        by_floor_total[r['floor']] += r['weight_kg']
        by_floor_count[r['floor']] += 1
    print('\n階  件数  合計kg')
    for f in sorted(by_floor_total):
        print(f'  {f}階  {by_floor_count[f]:>3}  {by_floor_total[f]:>8.2f}')
    print(f'  合計  {len(all_records):>3}  {sum(by_floor_total.values()):>8.2f}')

    extreme = [r for r in all_records if r['weight_kg'] >= 50]
    if extreme:
        print(f'\n異常値（50kg以上。書き間違いの疑い。参考表示のみ、移行自体は妨げない）: {len(extreme)}件')
        for r in extreme:
            print(f'  {r["date"]} {r["floor"]}階: {r["weight_kg"]}kg')

    if args.emit_sql:
        lines = [f"{r['date']}|{r['floor']}|{r['weight_kg']}" for r in all_records]
        sql = (
            "insert into waste_records (record_date, floor, weight_kg, source, is_confirmed)\n"
            "select split_part(t,'|',1)::date, split_part(t,'|',2), split_part(t,'|',3)::numeric,\n"
            "       'manual', true\n"
            "from unnest(string_to_array($D$\n" + '\n'.join(lines) +
            "\n$D$, E'\\n')) t\nwhere t <> ''\n"
            "on conflict (record_date, floor) do update\n"
            "  set weight_kg = excluded.weight_kg, source = excluded.source, is_confirmed = excluded.is_confirmed;\n"
        )
        with open(args.emit_sql, 'w', encoding='utf-8') as fp:
            fp.write(sql)
        print(f'\nSQLを書き出しました: {args.emit_sql}')
    else:
        print('\n（dry-run。SQLを出すには --emit-sql=<パス> を付けてください）')


if __name__ == '__main__':
    main()
