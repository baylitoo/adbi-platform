/* ADBI Factory — mascotte 3D animée du hub (héro d'accueil).
 *
 * Charge public/mascotte.glb (modèle optimisé : géométrie simplifiée, textures
 * WebP) avec three.js embarqué en local (public/vendor/ — aucune dépendance
 * réseau au chargement). L'animation est procédurale : entrée en fondu avec un
 * léger rebond au démarrage, puis rotation continue, flottement vertical et
 * orientation douce vers le pointeur.
 *
 * Fiabilité : tout échec (WebGL absent, fichier manquant, mémoire) est
 * silencieux — le conteneur reste simplement vide, le hub fonctionne pareil.
 */
(function () {
  "use strict";

  var conteneur = document.getElementById("mascotte");
  if (!conteneur || typeof THREE === "undefined") return;

  var largeur = conteneur.clientWidth || 190;
  var hauteur = conteneur.clientHeight || 190;

  var rendu;
  try {
    rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    return; // WebGL indisponible : pas de mascotte, pas d'erreur.
  }
  rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  rendu.setSize(largeur, hauteur);
  rendu.outputEncoding = THREE.sRGBEncoding;
  conteneur.appendChild(rendu.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(32, largeur / hauteur, 0.1, 100);
  camera.position.set(0, 0.6, 4.2);

  // Éclairage doux aux tons de la charte : une clé chaude, un contre bleu.
  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  var cle = new THREE.DirectionalLight(0xffffff, 1.1);
  cle.position.set(2.5, 4, 3);
  scene.add(cle);
  var contre = new THREE.DirectionalLight(0x6ea8f0, 0.5);
  contre.position.set(-3, 1, -2);
  scene.add(contre);

  var pivot = new THREE.Group();
  scene.add(pivot);

  // Position du pointeur (pour l'orientation douce) — inerte sur tactile.
  var cibleX = 0, cibleY = 0;
  window.addEventListener("pointermove", function (e) {
    cibleX = (e.clientX / window.innerWidth - 0.5) * 0.7;
    cibleY = (e.clientY / window.innerHeight - 0.5) * 0.35;
  }, { passive: true });

  var depart = null;
  var chargee = false;

  new THREE.GLTFLoader().load(
    "/mascotte.glb",
    function (gltf) {
      var modele = gltf.scene;

      // Centre le modèle et le met à l'échelle de la scène quelle que soit sa
      // taille d'origine (l'export Blender peut être en mètres ou en unités).
      var boite = new THREE.Box3().setFromObject(modele);
      var taille = boite.getSize(new THREE.Vector3());
      var centre = boite.getCenter(new THREE.Vector3());
      var echelle = 2.3 / Math.max(taille.x, taille.y, taille.z);
      modele.scale.setScalar(echelle);
      modele.position.sub(centre.multiplyScalar(echelle));

      pivot.add(modele);
      chargee = true;
      depart = performance.now();
      conteneur.classList.add("visible");
    },
    undefined,
    function () { /* fichier absent ou illisible : hub inchangé */ }
  );

  // Amortissement générique (animation indépendante de la cadence d'affichage).
  function approcher(actuel, cible, vitesse, dt) {
    return actuel + (cible - actuel) * Math.min(1, vitesse * dt);
  }

  var precedent = performance.now();
  function boucle(maintenant) {
    requestAnimationFrame(boucle);
    var dt = Math.min(0.05, (maintenant - precedent) / 1000);
    precedent = maintenant;
    if (!chargee) return;

    var t = (maintenant - depart) / 1000;

    // Entrée « au début » : montée + petit rebond d'échelle sur ~1,2 s.
    var entree = Math.min(1, t / 1.2);
    var rebond = entree < 1 ? 1 - Math.pow(1 - entree, 3) : 1;
    pivot.scale.setScalar(0.6 + 0.4 * rebond + (entree < 1 ? Math.sin(entree * Math.PI) * 0.06 : 0));

    // Vie permanente : rotation lente + flottement + orientation vers la souris.
    pivot.rotation.y = approcher(pivot.rotation.y, Math.sin(t * 0.45) * 0.55 + cibleX, 2.2, dt);
    pivot.rotation.x = approcher(pivot.rotation.x, cibleY - 0.05, 2.2, dt);
    pivot.position.y = Math.sin(t * 1.4) * 0.09 + (1 - rebond) * -0.8;

    rendu.render(scene, camera);
  }
  requestAnimationFrame(boucle);

  // Le héro est fluide : on suit la taille réelle du conteneur.
  window.addEventListener("resize", function () {
    var l = conteneur.clientWidth || largeur;
    var h = conteneur.clientHeight || hauteur;
    camera.aspect = l / h;
    camera.updateProjectionMatrix();
    rendu.setSize(l, h);
  });
})();
