(function () {
  "use strict";

  // The Worker's guestbook address. Same Worker that handles the quote form.
  var GUESTBOOK_URL = "https://forms.reprobate-guitars.com/guestbook";

  var form = document.getElementById("gb-form");
  var list = document.getElementById("gb-list");
  var countHeading = document.getElementById("gb-count");
  var statusBox = document.getElementById("gb-status");
  var btn = document.getElementById("gb-btn");

  function showStatus(kind, text) {
    if (!statusBox) { return; }
    statusBox.className = "status " + kind;
    statusBox.textContent = text;
  }

  // 10/21/98 style date stamp
  function stamp(seconds) {
    var d = new Date(seconds * 1000);
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    var yy = String(d.getFullYear()).slice(-2);
    return mm + "/" + dd + "/" + yy;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // textContent keeps visitor text from ever becoming HTML
    return e;
  }

  function render(entries, total) {
    list.innerHTML = "";
    if (countHeading) {
      countHeading.textContent = total === 1 ? "1 entry so far" : total + " entries so far";
    }
    if (!entries.length) {
      list.appendChild(el("p", "small", "No entries yet. Be the first to sign!"));
      return;
    }
    entries.forEach(function (e) {
      var box = el("div", "gb-entry");
      var head = el("div", "gb-head");
      var who = el("span", "gb-name", e.name);
      if (e.location) {
        who.appendChild(el("span", "gb-from", " from " + e.location));
      }
      head.appendChild(who);
      head.appendChild(el("span", "gb-date", stamp(e.created_at)));
      box.appendChild(head);
      box.appendChild(el("p", "gb-msg", e.message));
      list.appendChild(box);
    });
  }

  function load() {
    if (!list) { return Promise.resolve(); }
    return fetch(GUESTBOOK_URL)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) { throw new Error("bad response"); }
        render(data.entries || [], data.total || 0);
      })
      .catch(function () {
        list.innerHTML = "";
        list.appendChild(el("p", "small", "The guestbook is taking a nap. Try refreshing in a bit."));
      });
  }

  if (form) form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = form.elements.name.value.trim();
    var message = form.elements.message.value.trim();
    if (!name || !message) {
      showStatus("err", "Please fill in your name and a message.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Signing...";
    statusBox.className = "status";

    var data = new FormData();
    data.append("name", name);
    data.append("location", form.elements.location.value.trim());
    data.append("message", message);
    data.append("website", form.elements.website.value); // honeypot

    fetch(GUESTBOOK_URL, { method: "POST", body: data })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (!r.ok || !body.ok) { throw new Error(body.error || "Something went wrong."); }
        });
      })
      .then(function () {
        form.reset();
        showStatus("ok", "Thanks for signing! Taking you to the guestbook...");
        setTimeout(function () { window.location.href = "guestbook.html"; }, 1200);
      })
      .catch(function (err) {
        showStatus("err", (err && err.message) || "Something went wrong. Please try again.");
      })
      .then(function () {
        if (statusBox.className.indexOf("ok") === -1) {
          btn.disabled = false;
          btn.textContent = "Sign it!";
        }
      });
  });

  load();
})();
