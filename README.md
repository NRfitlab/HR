# HR Logger – Polar H10

PWA sans dépendance : enregistre la FC et les intervalles RR d'un Polar H10 (Web Bluetooth) avec marqueurs temps commentés. Mesures stockées localement dans le navigateur (IndexedDB), CSV exporté automatiquement à la fin de l'enregistrement.

## Utilisation
1. Ouvrir l'URL de l'app dans **Chrome ou Edge** (bureau ou Android ; Safari et Firefox n'ont pas Web Bluetooth).
2. Mettre la sangle (électrodes humidifiées). Fermer Polar Beat/Flow et toute autre appli connectée au H10.
3. **Connecter le H10** → choisir le capteur dans la fenêtre du navigateur.
4. **Démarrer l'enregistrement**.
5. **Marqueur** (bouton ou touche `M`) : l'instant est figé au clic, puis un champ permet d'ajouter un commentaire (Entrée valide, Échap ignore). Modifiable/supprimable dans la liste.
6. **Arrêter** : le CSV de la séance se télécharge automatiquement (dossier Téléchargements du navigateur) et la séance s'affiche en revue.

La liste « Séances enregistrées » permet de revoir une séance et de ré-exporter : CSV, CSV des marqueurs, JSON. Les données restent propres à chaque ordinateur/navigateur.

## Format CSV
Séparateur `;`, UTF-8 avec BOM (ouverture directe dans Excel FR). Colonnes : `elapsed_ms, elapsed, timestamp_iso, hr_bpm, rr_ms (séparés par espace), contact, marqueur`. Le commentaire d'un marqueur est placé sur le premier échantillon qui le suit ; les marqueurs postérieurs au dernier échantillon ont leur propre ligne.

## Déploiement (GitHub Pages)
```bash
git remote add origin git@github.com:<utilisateur>/<depot>.git   # ou l'URL HTTPS
git push -u origin main
```
Puis sur GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch → Branch : `main` / `(root)`**. L'app est servie sur `https://<utilisateur>.github.io/<depot>/` (HTTPS requis par Web Bluetooth). Installation PWA : icône d'installation dans la barre d'adresse de Chrome/Edge.

Après une mise à jour, bumper `CACHE` dans `sw.js` (ex. `hr-logger-v4`) pour forcer le rafraîchissement du cache hors ligne.

## Développement local
```bash
python3 -m http.server 8000   # puis http://localhost:8000
node tests/hr.test.js         # test du décodage Heart Rate Measurement
```

## Limites
- L'onglet doit rester ouvert ; l'écran est maintenu allumé pendant l'enregistrement (Wake Lock). Pas de BLE en arrière-plan.
- Une coupure Bluetooth déclenche une reconnexion automatique ; le trou dans les données n'est pas comblé.
- Un rechargement de page en cours de séance conserve les données déjà écrites (clôture au dernier échantillon) ; l'export automatique n'a pas lieu, utiliser la liste des séances.
