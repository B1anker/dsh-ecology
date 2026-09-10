/**
 * Sole owner of panel surface material. Layout rules must not set panel backgrounds,
 * backdrop filters or shadows. Keep opacity on the tint, never on the panel/content.
 */
export const panelMaterialStyles = `
.wl-page{--wl-panel-tint:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 42%,transparent);--wl-panel-blur:blur(14px) saturate(1.4)}
.wl-page :is(.wl-panel,.wl-inspector,.wl-dialog){background:var(--wl-panel-tint);backdrop-filter:var(--wl-panel-blur);-webkit-backdrop-filter:var(--wl-panel-blur);box-shadow:inset 0 1px 0 #ffffff80,inset 1px 0 0 #ffffff30}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.wl-page :is(.wl-panel,.wl-inspector,.wl-dialog){background:var(--dsw-alias-bg-layer-1,#fff)}}
`
