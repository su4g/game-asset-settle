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

const captureDialog = document.querySelector(".capture-dialog");
const dialogImage = captureDialog.querySelector("img");
const dialogTitle = captureDialog.querySelector("h2");
const originalLink = captureDialog.querySelector(".capture-original");

document.querySelectorAll("[data-gallery]").forEach(gallery => {
  const preview = gallery.querySelector(".capture-open");
  const previewImage = preview.querySelector("img");
  gallery.querySelectorAll("[data-capture]").forEach(link => {
    link.addEventListener("click", event => {
      // Keep normal link behavior for opening the original in another tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      previewImage.src = link.href;
      previewImage.alt = link.dataset.alt;
      preview.href = link.href;
      preview.setAttribute("aria-label", `放大查看 ${link.dataset.alt}`);
      gallery.querySelector(".capture-caption").textContent = link.dataset.caption;
      gallery.querySelectorAll("[data-capture]").forEach(item => {
        item.classList.toggle("is-active", item === link);
        if (item === link) item.setAttribute("aria-current", "true");
        else item.removeAttribute("aria-current");
      });
    });
  });
});

document.querySelectorAll("[data-lightbox]").forEach(link => {
  link.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !captureDialog.showModal) return;
    event.preventDefault();
    dialogImage.src = link.href;
    dialogImage.alt = link.querySelector("img").alt;
    dialogTitle.textContent = dialogImage.alt;
    originalLink.href = link.href;
    captureDialog.showModal();
    document.body.classList.add("capture-is-open");
  });
});
captureDialog.addEventListener("click", event => {
  if (event.target === captureDialog) captureDialog.close();
});
captureDialog.addEventListener("close", () => document.body.classList.remove("capture-is-open"));
