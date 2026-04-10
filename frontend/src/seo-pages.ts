import { initFooter } from "./footer";
import { initNav } from "./nav";

document.addEventListener("DOMContentLoaded", () => {
  initNav({ activePage: "landing" });
  initFooter();
});
