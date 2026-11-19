import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'

// 一覧の読み込み（再読み込み関数つき）
export function useList(path) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    api(path)
      .then((d) => {
        setItems(d.items)
        setError('')
      })
      .catch((e) => setError(e.message))
  }, [path])
  useEffect(() => {
    reload()
  }, [reload])
  return { items, error, reload }
}
