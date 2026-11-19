#!/usr/bin/env python3
"""FileMaker（eWork2）の「有給休暇取得実績」「特別休暇取得実績」を works_leaves に入れる SQL を作る。

データはリポジトリに入れない。手元で SQL を作り、Supabase の SQL Editor で実行する。
何度実行しても同じ結果になる（取込分 source='import' をいったん消して入れ直す。eWorks で登録した分は残す）。
並行運用の間は、FileMaker で登録した分を取り込み直すたびにこのスクリプトを使う。

使い方:
  python3 scripts/import-works-leaves.py --paid 有給休暇取得実績.csv --special 特別休暇取得実績.csv > works-leaves.sql

  有効フラグが 1 の行だけ取り込む（FileMaker の計算と同じ）。同じ日の重複は 1 日にまとめる（計算仕様 3 章）。
  担当者コードが works_staff に無い行は入らない（SQL の join で落ちる）。
"""
import argparse
import csv
import io
import sys


def read_csv(path):
    text = open(path, encoding='utf-8-sig', newline='').read().replace('\r\n', '\n').replace('\r', '\n')
    rows = list(csv.reader(io.StringIO(text)))
    return rows[0], [r for r in rows[1:] if any(c.strip() for c in r)]


def norm_date(s):
    y, m, d = s.strip().split(' ')[0].replace('/', '-').split('-')
    return f'{int(y):04d}-{int(m):02d}-{int(d):02d}'


def rows_of(path, kind):
    head, rows = read_csv(path)
    ic = head.index('担当者コード')
    idt = next(i for i, h in enumerate(head) if h.endswith('取得日'))
    iflag = head.index('有効フラグ')
    out = set()
    for r in rows:
        if r[iflag].strip() != '1' or not r[idt].strip():
            continue
        out.add((r[ic].strip(), norm_date(r[idt]), kind))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--paid', required=True)
    ap.add_argument('--special', required=True)
    a = ap.parse_args()
    rows = sorted(rows_of(a.paid, 'paid') | rows_of(a.special, 'special'))
    print('-- 有給休暇・特別休暇の取得日の取込（%d 行）' % len(rows))
    print('begin;')
    print("delete from works_leaves where source = 'import';")
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        values = ',\n  '.join("('%s', '%s', '%s')" % r for r in chunk)
        print('insert into works_leaves (staff_id, leave_date, kind, source)')
        print("select s.id, v.d::date, v.k, 'import' from (values\n  %s\n) as v(code, d, k)" % values)
        print('join works_staff s on s.code = v.code')
        print('on conflict (staff_id, leave_date, kind) do nothing;')
    print('commit;')
    print('select kind, count(*) from works_leaves group by kind;')


if __name__ == '__main__':
    sys.exit(main())
