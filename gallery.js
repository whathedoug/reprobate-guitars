(function () {
  "use strict";
  var links = Array.prototype.slice.call(document.querySelectorAll(".gal-item"));
  var box = document.getElementById("lightbox");
  var img = document.getElementById("lb-img");
  var cap = document.getElementById("lb-cap");
  if (!links.length || !box) { return; }
  var cur = 0, opener = null;

  function show(i) {
    cur = (i + links.length) % links.length;
    var a = links[cur];
    var thumb = a.querySelector("img");
    img.src = a.getAttribute("href");
    img.alt = thumb.alt;
    cap.textContent = thumb.alt + "  (" + (cur + 1) + " of " + links.length + ")";
  }
  function open(i, from) {
    opener = from;
    show(i);
    box.hidden = false;
    document.body.style.overflow = "hidden";
    box.querySelector(".lb-close").focus();
  }
  function close() {
    box.hidden = true;
    img.removeAttribute("src");
    document.body.style.overflow = "";
    if (opener) { opener.focus(); }
  }
  links.forEach(function (a, i) {
    a.addEventListener("click", function (ev) { ev.preventDefault(); open(i, a); });
  });
  box.querySelector(".lb-close").addEventListener("click", close);
  box.querySelector(".lb-prev").addEventListener("click", function () { show(cur - 1); });
  box.querySelector(".lb-next").addEventListener("click", function () { show(cur + 1); });
  box.addEventListener("click", function (ev) { if (ev.target === box) { close(); } });
  document.addEventListener("keydown", function (ev) {
    if (box.hidden) { return; }
    if (ev.key === "Escape") { close(); }
    else if (ev.key === "ArrowLeft") { show(cur - 1); }
    else if (ev.key === "ArrowRight") { show(cur + 1); }
  });
})();
