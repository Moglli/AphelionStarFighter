/**
 * @file Platform Designer — read-only inspector for the built-in platform
 * types.
 *
 * v1 surfaces the PLATFORM_TYPES library so the user can compare hull /
 * shield / weapon / range across the four defaults. Full per-blueprint
 * authoring (hull shape, module slot placement, custom weapon spec) is
 * the planned follow-up.
 *
 * Map Designer + Battle Designer reference platforms by `platformId` —
 * the strings shown here.
 */

import { PLATFORM_TYPES, PLATFORM_TYPE_KEYS } from "../platforms/registry.js";

const STATS = [
  { key: "hp",     label: "HP",          pick: (s) => s.hp },
  { key: "shield", label: "SHIELD",      pick: (s) => s.shield && s.shield.max },
  { key: "sregen", label: "SHIELD/s",    pick: (s) => s.shield && s.shield.regen },
  { key: "dmg",    label: "DMG/shot",    pick: (s) => s.weapon && s.weapon.damage },
  { key: "cool",   label: "CYCLE (s)",   pick: (s) => s.weapon && s.weapon.cooldown },
  { key: "range",  label: "RANGE",       pick: (s) => s.weapon && s.weapon.range },
  { key: "pdcnt",  label: "PD turrets",  pick: (s) => s.pdCannons && s.pdCannons.count },
];

export class PlatformDesigner {
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this._visible = false;
    this._mount();
  }

  _mount() {
    const el = document.createElement("div");
    el.id = "platform-designer";
    el.className = "platform-designer hidden";
    el.innerHTML = `
      <div class="pd-panel">
        <header class="pd-header">
          <span class="pd-title">PLATFORM TYPES</span>
          <button class="pd-x" id="pd-close" title="Close">✕</button>
        </header>
        <section class="pd-body">
          <div class="pd-grid" id="pd-grid"></div>
          <p class="pd-hint">Reference these IDs in maps + scenarios. Place via the Map Designer's PLATFORM tool.</p>
        </section>
      </div>
    `;
    this.host.appendChild(el);
    this._el = el;
    this._gridEl = el.querySelector("#pd-grid");
    el.querySelector("#pd-close").addEventListener("click", () => this.hide());
    this._render();
  }

  isVisible() { return this._visible; }
  show() { this._visible = true; this._el.classList.remove("hidden"); this._render(); }
  hide() { this._visible = false; this._el.classList.add("hidden"); if (this.deps.onClose) this.deps.onClose(); }
  toggle() { if (this._visible) this.hide(); else this.show(); }

  _render() {
    const grid = this._gridEl;
    grid.innerHTML = "";
    for (const key of PLATFORM_TYPE_KEYS) {
      const type = PLATFORM_TYPES[key];
      const card = document.createElement("div");
      card.className = "pd-card";
      const stats = STATS
        .map((s) => {
          const v = s.pick(type.spec);
          if (v == null) return null;
          return `<div class="pd-stat"><span class="pd-stat-label">${s.label}</span><span class="pd-stat-value">${formatStat(v)}</span></div>`;
        })
        .filter(Boolean)
        .join("");
      card.innerHTML = `
        <div class="pd-card-header">
          <span class="pd-card-name">${type.name}</span>
          <span class="pd-card-id">${type.id}</span>
        </div>
        <p class="pd-card-blurb">${type.blurb || ""}</p>
        <div class="pd-card-stats">${stats}</div>
      `;
      grid.appendChild(card);
    }
  }
}

function formatStat(v) {
  if (typeof v !== "number") return String(v);
  if (Math.abs(v) >= 100) return Math.round(v).toString();
  if (Math.abs(v) >= 1) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2);
}
