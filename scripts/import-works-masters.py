#!/usr/bin/env python3
"""FileMaker（eWork2・eSales）から書き出したマスタを、eWorks のテーブルに入れる SQL を作る。

データ（個人名を含む）はリポジトリに入れない。手元で SQL を作り、Supabase の SQL Editor で実行する。
何度実行しても同じ結果になる（コード・タイプ名で上書き。勤務体系は 担当者×適用開始日 で上書き）。

使い方:
  python3 scripts/import-works-masters.py \
    --patterns 出退勤パターン.csv --sites 作業マスタ.csv --schedules 担当者作業マスタ.xml \
    --parm parm.xml --esales eSales担当者マスタ.csv --employees 勤怠システム_従業員.csv \
    --active 0001,0007,... --valid-from 2026-12-01 > works-import.sql

  --active     現在在籍している担当者コード（カンマ区切り）。ここに無い人は「退職」で登録する
               （勤怠システムの従業員マスタの「休職中」は最新でないため使わない。2026-11-18）
  --valid-from 勤務体系の適用開始日（既定 2026-12-01）

取り込まないもの（決定事項 11・13）: 携帯電話・IC カード番号・GPS・給与関連。
"""
import argparse
import csv
import io
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET

FM = '{http://www.filemaker.com/fmpxmlresult}'


def norm(s):
    return unicodedata.normalize('NFC', (s or '').strip())


def read_csv(path):
    text = open(path, encoding='utf-8-sig', newline='').read().replace('\r\n', '\n').replace('\r', '\n')
    rows = list(csv.reader(io.StringIO(text)))
    head = [norm(h) for h in rows[0]]
    return [dict(zip(head, (norm(c) for c in r))) for r in rows[1:] if any(c.strip() for c in r)]


def read_fmxml(path):
    root = ET.parse(path).getroot()
    names = [f.get('NAME') for f in root.iter(FM + 'FIELD')]
    out = []
    for row in root.iter(FM + 'ROW'):
        cols = [[norm(d.text) if d.text else None for d in c.findall(FM + 'DATA')] for c in row.findall(FM + 'COL')]
        out.append(dict(zip(names, cols)))
    return out


def q(v):
    if v is None or v == '':
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    return "'" + str(v).replace("'", "''") + "'"


def date(s):
    s = (s or '').strip().split(' ')[0].replace('/', '-')
    m = re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})$', s)
    return f'{int(m[1]):04d}-{int(m[2]):02d}-{int(m[3]):02d}' if m else None


def hm(s):
    m = re.match(r'^(\d{1,2}):(\d{2})', (s or '').strip())
    return f'{int(m[1]):02d}:{m[2]}' if m else None


def main():
    ap = argparse.ArgumentParser()
    for k in ('patterns', 'sites', 'schedules', 'parm', 'esales', 'employees'):
        ap.add_argument('--' + k, required=True)
    ap.add_argument('--active', required=True)
    ap.add_argument('--valid-from', default='2026-12-01')
    a = ap.parse_args()
    active = {c.strip() for c in a.active.split(',') if c.strip()}
    out = ['-- eWorks マスタ取り込み（scripts/import-works-masters.py で生成。個人名を含むのでコミットしない）', 'begin;']

    # 出退勤パターン
    pats = read_csv(a.patterns)
    for p in pats:
        out.append(
            'insert into works_shift_patterns (name, start_time, end_time, active, legacy_id) values '
            f"({q(p['タイプ'])}, {q(hm(p['出勤予定時刻']))}, {q(hm(p['退勤予定時刻']))}, {q(p['ステータス'] == '正常')}, {q(p['ID'])}) "
            'on conflict (name) do update set start_time = excluded.start_time, end_time = excluded.end_time, '
            'active = excluded.active, legacy_id = excluded.legacy_id, updated_at = now();'
        )

    # 現場（作業マスタ）。位置は後で画面から入れる
    sites = read_csv(a.sites)
    for s in sites:
        out.append(
            f"insert into works_sites (code, name, detail) values ({q(s['作業コード'])}, {q(s['作業名称'])}, {q(s['作業詳細'])}) "
            'on conflict (code) do update set name = excluded.name, detail = excluded.detail, updated_at = now();'
        )

    # スタッフ: 勤務体系か従業員マスタにいる人。氏名・ふりがな・所属・入社日は eSales 担当者マスタから
    esales = {r['担当者コード']: r for r in read_csv(a.esales)}
    emps = {r['従業員番号']: r for r in read_csv(a.employees)}
    # 曜日別タイプも主要作業も空の行（コードだけの行）は取り込まない
    scheds = [
        r for r in read_fmxml(a.schedules)
        if r['担当者コード'][0] and (r['主要作業コード'][0] or any(r['曜日別タイプ']))
    ]
    # 同じ担当者の行が 2 つ以上あれば、主要作業と曜日の入力が多い方を使う
    best = {}
    for r in scheds:
        c = r['担当者コード'][0]
        score = (1 if r['主要作業コード'][0] else 0) * 10 + sum(1 for t in r['曜日別タイプ'] if t)
        if c in best:
            print(f'-- 注意: 担当者 {c} の勤務体系が 2 行以上あります（入力の多い方を使います）', file=sys.stderr)
        if c not in best or score > best[c][0]:
            best[c] = (score, r)
    scheds = [r for _, r in best.values()]
    codes = sorted({r['担当者コード'][0] for r in scheds if r['担当者コード'][0]} | set(emps) | active)
    missing = [c for c in codes if c not in esales]
    if missing:
        print(f'-- 注意: eSales 担当者マスタに無いコード: {", ".join(missing)}', file=sys.stderr)
    for c in codes:
        e = esales.get(c, {})
        name = e.get('担当者名') or emps.get(c, {}).get('名前') or c
        pattern = emps.get(c, {}).get('出退勤タイプ')
        status = 'active' if c in active else 'retired'
        out.append(
            'insert into works_staff (code, name, kana, dept, hired_on, status, default_pattern_id) values '
            f"({q(c)}, {q(name)}, {q(e.get('ふりがな'))}, {q(e.get('所属'))}, {q(date(e.get('入社日')))}, {q(status)}, "
            f'(select id from works_shift_patterns where name = {q(pattern)})) '
            'on conflict (code) do update set name = excluded.name, kana = excluded.kana, dept = excluded.dept, '
            'hired_on = excluded.hired_on, status = excluded.status, '
            'default_pattern_id = coalesce(excluded.default_pattern_id, works_staff.default_pattern_id), updated_at = now();'
        )

    # 勤務体系（担当者作業マスタ）。曜日は 日〜土 の 7 要素
    for r in scheds:
        c = r['担当者コード'][0]
        types = (r['曜日別タイプ'] + [None] * 7)[:7]
        bs = (r['個別休憩時間開始'] + [None] * 7)[:7]
        be = (r['個別休憩時間終了'] + [None] * 7)[:7]
        overrides = [
            f'{{"dow":{d},"start":"{hm(bs[d])}","end":"{hm(be[d])}"}}' for d in range(7) if hm(bs[d]) and hm(be[d])
        ]
        ids = ', '.join(f'(select id from works_shift_patterns where name = {q(t)})' if t else 'null' for t in types)
        commute = (r['通勤手当'][0] or '0') not in ('0', '')
        out.append(
            'insert into works_staff_schedules (staff_id, valid_from, main_site_id, weekday_pattern_ids, break_overrides, commute_allowance) '
            f'select s.id, {q(a.valid_from)}, (select id from works_sites where code = {q(r["主要作業コード"][0])}), '
            f"array[{ids}]::uuid[], {q('[' + ','.join(overrides) + ']')}::jsonb, {q(commute)} "
            f'from works_staff s where s.code = {q(c)} '
            'on conflict (staff_id, valid_from) do update set main_site_id = excluded.main_site_id, '
            'weekday_pattern_ids = excluded.weekday_pattern_ids, break_overrides = excluded.break_overrides, '
            'commute_allowance = excluded.commute_allowance, updated_at = now();'
        )

    # パターン名の綴りが違うと、その曜日が「休み」になってしまうので知らせる
    known = {p['タイプ'] for p in pats}
    unknown = sorted({t for r in scheds for t in r['曜日別タイプ'] if t and t not in known}
                     | {e['出退勤タイプ'] for e in emps.values() if e.get('出退勤タイプ') and e['出退勤タイプ'] not in known})
    if unknown:
        print(f'-- 注意: 出退勤パターンに無いタイプ名（休み・未設定として扱われます）: {", ".join(unknown)}', file=sys.stderr)

    # 設定（Parm）: 休憩時間帯
    parm = read_fmxml(a.parm)[0]
    wins = [
        f'{{"start":"{hm(s)}","end":"{hm(e)}"}}'
        for s, e in zip(parm['休憩時間開始'], parm['休憩時間終了'])
        if hm(s) and hm(e)
    ]
    out.append(f"update works_settings set break_windows = {q('[' + ','.join(wins) + ']')}::jsonb, updated_at = now() where id = 1;")
    out.append('commit;')
    print('\n'.join(out))
    n_active = sum(1 for c in codes if c in active)
    print(
        f'-- パターン {len(pats)} 件（使用中 {sum(p["ステータス"] == "正常" for p in pats)}）・現場 {len(sites)} 件・'
        f'スタッフ {len(codes)} 名（在籍 {n_active}）・勤務体系 {len(scheds)} 件',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main()
