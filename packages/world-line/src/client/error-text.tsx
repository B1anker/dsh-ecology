/**
 * 统一错误展示，与现有各处 <p className="wl-error" role="alert">{message}</p> 逐字一致。
 * role 传 null 时不输出 role 属性（外层容器已带 role 的场合，如 merge-panel 错误块）。
 */
export function ErrorText({
  message,
  role = 'alert',
}: {
  message: string
  role?: 'alert' | 'status' | null
}) {
  return (
    <p className="wl-error" role={role ?? undefined}>
      {message}
    </p>
  )
}
