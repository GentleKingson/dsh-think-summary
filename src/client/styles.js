/**
 * 样式（apply 时注入一次 <style>）。
 * 使用宿主颜色、边框和状态标签变量。
 * dock 面板宽度沿用官方 todo/queue dock 公式。
 */
const PANEL_CSS = `
/* ---------- 输入框上方实时面板（对齐原生 QueueDock） ---------- */
.ts-dock{box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset)}
.ts-dock-panel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);box-shadow:var(--dsw-shadow-lv1);border-radius:12px;width:100%;overflow:hidden}
.ts-dock-head{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);text-align:left;align-items:center;gap:10px;padding:4px 8px 4px 4px;display:flex}
.ts-dock-toggle{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid;transition:background-color 120ms ease}
.ts-dock-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .12s}
/* 展开时箭头朝下（指向内容），收起时朝上 */
.ts-dock[data-open="false"] .ts-dock-chevron{transform:rotate(180deg)}
.ts-dock-paused{flex:none;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
/* 暂停/继续：对齐对话底部圆形功能按钮（28px、radius 999、grid 居中） */
.ts-dock-pause{cursor:pointer;width:28px;height:28px;color:var(--dsw-alias-label-secondary);background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid;transition:color 120ms ease,background-color 120ms ease}
.ts-dock-pause:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-pause.on{color:var(--dsw-alias-state-warn-primary)}
.ts-dock-pause:disabled{opacity:.5;cursor:default}
.ts-dock-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.ts-dock-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden}
.ts-dock-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.ts-dock-body{flex-direction:column;max-height:220px;padding:2px 0;display:flex;overflow-y:auto}
.ts-dock-seg{flex:none;padding:6px 12px 6px 24px}
.ts-dock-seg + .ts-dock-seg{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-dock-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.ts-dock-placeholder{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}

/* ---------- 状态标签：原生 pill badge ---------- */
.ts-seg-refined,.ts-seg-skip,.ts-seg-pending,.ts-seg-self{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ts-seg-refined{color:var(--dsw-alias-state-business-primary)}
.ts-seg-skip{color:var(--dsw-alias-label-tertiary)}
.ts-seg-pending{color:var(--dsw-alias-label-tertiary)}
.ts-seg-self{color:var(--dsw-alias-state-warn-primary)}

/* ---------- 对话末尾思考总结条（对齐原生卡片） ---------- */
.ts-tail{margin:4px 16px 4px 30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden;transition:border-color .16s,background .16s}
.ts-tail:hover{border-color:var(--dsw-alias-label-dimmed)}
.ts-tail[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ts-tail-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-tail-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-tail-chevron{transition:transform .16s;color:var(--dsw-alias-label-tertiary);flex:none}
.ts-tail[data-open="true"] .ts-tail-chevron{transform:rotate(180deg)}
.ts-tail-title{font-weight:600}
.ts-tail-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.ts-tail-refined{color:var(--dsw-alias-state-business-primary);font-size:11px;font-weight:500}
.ts-tail-body{border-top:1px solid var(--dsw-alias-border-l2);max-height:320px;overflow-y:auto}
.ts-tail-seg{padding:6px 12px 6px 26px}
.ts-tail-seg + .ts-tail-seg{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-tail-group + .ts-tail-group{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-tail-group-head{padding:5px 12px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);letter-spacing:.02em}
.ts-tail-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-tail-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}

/* ---------- 思考总结视图（对齐原生 trajectory 工具栏 + 原生卡片） ---------- */
.ts-view{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 2 * var(--dsh-composer-dock-inset, 8px));margin:0 auto;padding:0 12px 32px}
.ts-view-header{position:sticky;top:0;z-index:1;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);align-items:baseline;gap:10px;padding:8px 4px;display:flex}
.ts-view-title-lg{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ts-view-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-view-empty{padding:24px 4px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.ts-view-list{flex-direction:column;gap:10px;padding-top:10px;display:flex}
.ts-view-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden;transition:border-color .16s,background .16s}
.ts-view-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.ts-view-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ts-view-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-view-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-view-chevron{transition:transform .16s;color:var(--dsw-alias-label-tertiary);flex:none}
.ts-view-card[data-open="true"] .ts-view-chevron{transform:rotate(180deg)}
.ts-view-title{font-weight:600}
.ts-view-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ts-view-body{border-top:1px solid var(--dsw-alias-border-l2);max-height:360px;overflow-y:auto}
.ts-view-seg{padding:6px 12px 6px 26px}
.ts-view-seg + .ts-view-seg{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-view-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-view-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}

`
