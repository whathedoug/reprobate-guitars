(function () {
  "use strict";

  // Where the form gets sent. This is the Cloudflare Worker (see /worker).
  // Leave empty until the Worker is deployed; the form will then tell visitors to text or email instead.
  var FORM_ENDPOINT = "https://forms.reprobate-guitars.com/contact";

  var MAX_PHOTOS = 5;
  var MAX_DIMENSION = 1600; // longest side in pixels after shrinking
  var JPEG_QUALITY = 0.8;

  var form = document.getElementById("quote-form");
  var statusBox = document.getElementById("status");
  var submitBtn = document.getElementById("submit-btn");
  var photoInput = document.getElementById("photos");
  var previews = document.getElementById("previews");

  /* ---------- Visitor counter (a joke: it's per-browser, not a real count) ---------- */
  try {
    var counter = document.getElementById("counter");
    var n = parseInt(localStorage.getItem("rg_visits") || "1997", 10) + 1;
    localStorage.setItem("rg_visits", String(n));
    counter.textContent = String(n).padStart(6, "0");
  } catch (e) { /* storage blocked: leave the default digits */ }

  /* ---------- Helpers ---------- */
  function showStatus(kind, text) {
    statusBox.className = "status " + kind;
    statusBox.textContent = text;
  }

  // Shrink a photo in the browser so uploads are fast and the email stays small.
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) { reject(new Error("Could not process " + file.name)); return; }
          var base = file.name.replace(/\.[^.]+$/, "") || "photo";
          resolve(new File([blob], base + ".jpg", { type: "image/jpeg" }));
        }, "image/jpeg", JPEG_QUALITY);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read " + file.name + ". Try a JPG or PNG."));
      };
      img.src = url;
    });
  }

  /* ---------- Photo previews ---------- */
  photoInput.addEventListener("change", function () {
    previews.innerHTML = "";
    var files = Array.prototype.slice.call(photoInput.files);
    if (files.length > MAX_PHOTOS) {
      showStatus("err", "Max " + MAX_PHOTOS + " photos, please. Only the first " + MAX_PHOTOS + " will be sent.");
      files = files.slice(0, MAX_PHOTOS);
    } else {
      statusBox.className = "status";
    }
    files.forEach(function (f) {
      var img = document.createElement("img");
      img.alt = "Photo preview";
      img.src = URL.createObjectURL(f);
      img.onload = function () { URL.revokeObjectURL(img.src); };
      previews.appendChild(img);
    });
  });

  /* ---------- Submit ---------- */
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();

    var name = form.elements.name.value.trim();
    var email = form.elements.email.value.trim();
    var message = form.elements.message.value.trim();

    if (!name || !email || !message) {
      showStatus("err", "Please fill in your name, email and a short message.");
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showStatus("err", "That email address doesn't look right. Double-check it?");
      return;
    }
    if (!FORM_ENDPOINT) {
      showStatus("err", "The form isn't switched on yet. Please text 417-247-6228 or email reprobateguitars@gmail.com instead.");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";
    showStatus("ok", "Sending your request. Photos can take a few seconds...");

    var files = Array.prototype.slice.call(photoInput.files).slice(0, MAX_PHOTOS);

    Promise.all(files.map(shrinkImage))
      .then(function (shrunk) {
        var data = new FormData();
        data.append("name", name);
        data.append("email", email);
        data.append("phone", form.elements.phone.value.trim());
        data.append("instrument", form.elements.instrument.value.trim());
        data.append("service", form.elements.service.value);
        data.append("message", message);
        data.append("website", form.elements.website.value); // honeypot
        shrunk.forEach(function (f) { data.append("photos", f, f.name); });
        return fetch(FORM_ENDPOINT, { method: "POST", body: data });
      })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body.ok) { throw new Error(body.error || "Something went wrong."); }
        });
      })
      .then(function () {
        form.reset();
        previews.innerHTML = "";
        showStatus("ok", "Got it! Thanks, we'll holler back soon. Need it faster? Text 417-247-6228.");
      })
      .catch(function (err) {
        showStatus("err", (err && err.message ? err.message + " " : "") +
          "Please try again, or text 417-247-6228 / email reprobateguitars@gmail.com.");
      })
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send it!";
      });
  });
})();
