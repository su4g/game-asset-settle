"use strict";
// All content and primary links work without JavaScript.
const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#site-nav");
document.documentElement.classList.add("js");
function setMenu(open, restoreFocus = false) {
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "关闭导航" : "打开导航");
  navigation.dataset.open = String(open);
  if (restoreFocus) menuButton.focus();
}
menuButton.addEventListener("click", () => setMenu(menuButton.getAttribute("aria-expanded") !== "true"));
navigation.addEventListener("click", event => {
  if (event.target.closest("a")) setMenu(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") setMenu(false, true);
});
document.addEventListener("click", event => {
  if (!event.target.closest(".site-header") && menuButton.getAttribute("aria-expanded") === "true") setMenu(false);
});
window.matchMedia("(min-width: 621px)").addEventListener("change", event => {
  if (event.matches) setMenu(false);
});
