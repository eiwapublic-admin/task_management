// タスクの表示用ID。DBの主キーはUUIDで長く、口頭や依頼文で伝えにくいため、
// 別に持たせた連番（tasks.task_no）を「T-123」の形で表示・検索に使う。
export function formatTaskId(task) {
  const no = task?.task_no
  if (no === null || no === undefined || no === '') return ''
  return `T-${no}`
}
