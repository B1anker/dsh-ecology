/** Option 1: compact task rows and paired investigation controls. */
export const taskDiagnosisStyles = `
.wl-page .wl-inspector.wl-task-panel{width:620px}
.wl-page .wl-inspector.wl-diagnosis-panel{width:680px}
.wl-page .wl-task-notifications{border:0;background:transparent;padding:6px;font-size:12px;flex:none}
.wl-page .wl-task-panel .wl-task-list-heading{margin:8px 0 0;padding:16px 0;border-block:1px solid var(--wl-hud-border)}
.wl-task-list{display:grid}
.wl-page .wl-task-panel .wl-task-card{grid-template-columns:minmax(0,1fr) auto auto;column-gap:18px;row-gap:8px;padding:22px 12px;border:0;border-bottom:1px solid var(--wl-hud-border);border-radius:0;background:transparent}
.wl-page .wl-task-panel .wl-task-card>strong{grid-column:1;grid-row:1;font-size:14px}
.wl-page .wl-task-panel .wl-task-state{grid-column:2;grid-row:1;align-self:center;font-size:12px;padding:2px 6px;background:transparent}
.wl-page .wl-task-panel .wl-task-card>.wl-task-open:first-of-type{grid-column:3;grid-row:1/3;align-self:start;min-height:36px;white-space:nowrap}
.wl-task-meta{grid-column:1/3;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline;color:var(--dsw-alias-label-secondary);font-size:12px;min-width:0}
.wl-task-meta time{font-size:12px!important;font-variant-numeric:tabular-nums}
.wl-page .wl-task-panel .wl-task-card:is([data-status=fail],[data-status=error],[data-status=review]){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 4%,transparent)}
.wl-page .wl-task-panel .wl-task-card>.wl-error{grid-column:1/-1;padding:10px 12px;margin:4px 0;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
.wl-page .wl-task-details{grid-column:1/-1}
.wl-page .wl-task-details summary{padding:4px 0;color:var(--wl-accent)}
.wl-page .wl-task-details .wl-button{width:auto;border-color:transparent;background:transparent;padding:4px 0;margin-right:18px;color:var(--wl-accent)}
.wl-page .wl-diagnosis-body{gap:22px}
.wl-page .wl-diagnosis-body>.wl-hud-tabs{position:static;display:flex;justify-content:flex-start;border:0;border-bottom:1px solid var(--wl-hud-border);border-radius:0;padding:0;gap:16px}
.wl-page .wl-diagnosis-body>.wl-hud-tabs [role=tab]{flex:none;width:auto;padding:12px 16px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent}
.wl-page .wl-diagnosis-body>.wl-hud-tabs [aria-selected=true]{border-bottom-color:var(--wl-menu-gold);font-weight:600}
.wl-page .wl-diagnosis-body>.wl-button{width:auto;justify-self:end}
.wl-page .wl-diagnosis-form{display:flex;flex-direction:column;gap:24px;min-width:0}
.wl-page .wl-diagnosis-form[hidden]{display:none}
.wl-diagnosis-methods{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;border:0;padding:0;margin:0;min-width:0}
.wl-diagnosis-methods legend{padding:0;margin-bottom:14px;font-size:14px;font-weight:550}
.wl-page .wl-diagnosis-choice{display:flex;align-items:flex-start;gap:12px;border:1px solid var(--wl-hud-border);border-radius:6px;padding:16px;cursor:pointer;min-width:0}
.wl-page .wl-diagnosis-choice:has(:checked){border-color:var(--wl-menu-gold);background:color-mix(in srgb,var(--wl-menu-gold) 6%,transparent)}
.wl-page .wl-diagnosis-choice:has(:disabled){cursor:wait;opacity:.65}
.wl-page .wl-diagnosis-choice input[type=radio]{appearance:auto;display:block;width:18px;height:18px;min-height:0;padding:0;margin:2px 0 0;flex:none;accent-color:var(--wl-menu-gold)}
.wl-page .wl-diagnosis-choice input::after{display:none}
.wl-diagnosis-choice span{display:grid;gap:8px;min-width:0}
.wl-diagnosis-choice strong{font-size:14px;font-weight:550}
.wl-diagnosis-choice small{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.wl-page .wl-diagnosis-form .wl-diagnosis-note{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;margin:0;border-radius:6px;background:color-mix(in srgb,var(--wl-accent) 6%,transparent);font-size:12px;color:var(--dsw-alias-label-secondary)}
.wl-diagnosis-note svg{flex:none;color:var(--wl-accent);margin-top:1px}
.wl-diagnosis-section-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
.wl-page .wl-diagnosis-section-heading h3{margin:0}
.wl-page .wl-diagnosis-section-heading .wl-text-action{width:auto;border:0;background:transparent;color:var(--wl-accent);padding:4px 0}
.wl-diagnosis-pair{display:grid;grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr);align-items:start;gap:16px}
.wl-diagnosis-pair>div{min-width:0}
.wl-diagnosis-arrow{margin-top:35px;color:var(--dsw-alias-label-tertiary)}
.wl-page .wl-diagnosis-help{min-height:36px;margin:12px 0 0;line-height:1.5}
.wl-page .wl-diagnosis-footer{display:flex;align-items:center;gap:12px;border-top:1px solid var(--wl-hud-border);padding-top:20px;margin-top:8px}
.wl-page .wl-panel-footer:has(>.wl-research-footer-slot:empty){display:none}
.wl-research-footer-slot{width:100%}
.wl-page .wl-research-footer-slot .wl-diagnosis-footer{border:0;margin:0;padding:0}
.wl-page .wl-research-footer-slot .wl-diagnosis-footer>.wl-button:last-child{margin-left:0}
.wl-diagnosis-footer>span{flex:1;min-width:0}
.wl-page .wl-diagnosis-footer>.wl-button{flex:none;width:auto;min-height:38px;padding-inline:18px}
.wl-page .wl-diagnosis-footer>.wl-primary{background:var(--wl-menu-gold);border-color:var(--wl-menu-gold);color:var(--wl-menu-ink)}
@media(max-width:760px){
.wl-page .wl-task-panel .wl-panel-header{flex-wrap:wrap;gap:10px}
.wl-page .wl-task-notifications span{display:none}
.wl-page .wl-task-panel .wl-task-card{grid-template-columns:minmax(0,1fr) auto;padding:18px 0;gap:8px}
.wl-page .wl-task-panel .wl-task-card>.wl-task-open:first-of-type{grid-column:2;grid-row:2/4}
.wl-task-meta{grid-column:1;flex-direction:column;gap:2px}
.wl-diagnosis-methods{grid-template-columns:1fr}
.wl-diagnosis-pair{grid-template-columns:minmax(0,1fr);gap:16px}
.wl-diagnosis-arrow{display:none}
.wl-page .wl-diagnosis-footer{flex-wrap:wrap}
.wl-diagnosis-footer>span{flex-basis:100%}
.wl-diagnosis-footer>.wl-button:nth-last-child(2){margin-left:auto}
}
`
