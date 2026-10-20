"""xlsx の先頭シートを JSON（行の配列）にする。検針の出力の照合用（scripts/verify-meter-output.mjs）。

使い方: python3 scripts/dump-xlsx-json.py 検針データ_2026年10月分.xlsx > expected.json
日付は 'YYYY-MM-DD'、時刻は 'HH:MM:SS' の文字列にする。
"""
import datetime
import json
import sys
import warnings

import openpyxl

warnings.filterwarnings('ignore')


def cell(v):
    if isinstance(v, datetime.datetime):
        return {'type': 'date', 'value': v.strftime('%Y-%m-%d')}
    if isinstance(v, datetime.timedelta):
        s = int(v.total_seconds())
        return {'type': 'time', 'value': f'{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}'}
    if isinstance(v, datetime.time):
        return {'type': 'time', 'value': v.strftime('%H:%M:%S')}
    return v


ws = openpyxl.load_workbook(sys.argv[1]).active
json.dump([[cell(v) for v in row] for row in ws.iter_rows(values_only=True)], sys.stdout, ensure_ascii=False)
