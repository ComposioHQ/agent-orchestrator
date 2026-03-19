(function () {
  try {
    var t = localStorage.getItem("ao-theme");
    if (t === "light") document.documentElement.classList.add("light");
  } catch (e) {}
})();
