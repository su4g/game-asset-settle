(function () {
  "use strict";
  // All symbols describe an action or destination. Platform marks are original local assets.
  const paths = {
    overview: ["M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"],
    ledger: ["M12 5v16M12 5C8 2 4 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-3-1-6-2-10 1"],
    report: ["M3 3v18h18M7 14l4-4 4 3 6-7M17 6h4v4"],
    alchemy: ["M9 3h6M10 3v6L4 19a1.3 1.3 0 0 0 1.2 2h13.6a1.3 1.3 0 0 0 1.2-2L14 9V3M7.5 14h9M9 17h.01M14 18h.01"],
    history: ["M3 3h18v5H3zM5 8v13h14V8M9 12h6"],
    calculator: ["M5 2h14v20H5zM8 6h8M8 11h1M15 11h1M8 15h1M15 15h1M8 19h1M15 19h1"],
    accounts: ["M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2", "M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0"],
    runtime: ["M2 12h4l3-8 6 16 3-8h4"],
    refresh: ["M20 8A8 8 0 0 0 6 5L3 8M3 3v5h5M4 16a8 8 0 0 0 14 3l3-3M21 21v-5h-5"],
    chevron: ["M9 5l7 7-7 7"],
    info: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 11v6M12 7h.01"],
    cloud: ["M7 18a5 5 0 1 1 0-10 7 7 0 0 1 13 2 4 4 0 0 1-1 8M12 13v8M9 18l3 3 3-3"],
    percent: ["M5 19 19 5M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0"]
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false"); svg.classList.add("ui-icon");
    for (const d of paths[name] || paths.info) { const p = document.createElementNS(svg.namespaceURI, "path"); p.setAttribute("d", d); svg.append(p); }
    return svg;
  }
  function platformLogo(platform) {
    if (!["buff", "uu", "steam"].includes(platform)) return icon("history");
    const img = document.createElement("img");
    img.src = `assets/platforms/${platform}.png`; img.alt = ""; img.className = "platform-logo";
    img.width = 24; img.height = 24; img.draggable = false; return img;
  }
  window.LedgerBrand = Object.freeze({ icon, platformLogo });
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceChildren(icon(el.dataset.icon));
  for (const el of document.querySelectorAll("[data-platform-logo]")) el.replaceChildren(platformLogo(el.dataset.platformLogo));
  for (const region of document.querySelectorAll(".quote-table-wrap, .chart-table-wrap")) {
    region.tabIndex = 0; region.setAttribute("role", "region");
    region.setAttribute("aria-label", region.querySelector("caption")?.textContent || "交易数据，可左右滚动");
  }
  // Animation is decorative and never delays requests or prevents interaction.
  const launch = document.getElementById("appLaunch");
  if (launch) setTimeout(() => launch.remove(), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 950);
})();
