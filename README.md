# Protection Bebe - Dashboard Serie USB

Dashboard web local multi-ecrans: un serveur Python lit l USB serie STM32, puis diffuse les donnees au dashboard pour PC et telephone sur le meme reseau Wi-Fi.

## Prerequis
- macOS
- Python 3.9+
- Package Python: `pyserial`
- STM32CubeIDE avec `printf` UART fonctionnel
- Cablage capteurs selon votre montage

## Installation
Depuis la racine du projet:

```bash
python3 -m pip install pyserial
```

## Lancer le pont local
Depuis la racine du projet:

```bash
python3 bridge_server.py --host 0.0.0.0 --port 5500
```

Puis ouvrir:

```txt
http://localhost:5500
```

Pour le telephone sur le meme Wi-Fi:

```txt
http://IP_DE_TON_PC:5500
```

## Utilisation
1. Cliquer `Rafraichir Ports`.
2. Choisir le port serie STM32 dans la liste.
3. Cliquer `Connecter STM32`.
4. Verifier que les valeurs se mettent a jour.
5. Ajuster la frequence avec le slider, puis cliquer `Envoyer`.
6. Utiliser `Heart Rate`:
	- `Lire maintenant` envoie `GET_HR`
	- `Mode continu` ON/OFF envoie `HR_STREAM:1` ou `HR_STREAM:0`

## Format serie attendu
Une donnee par ligne:

```txt
T_BODY:36.8
HR:142
MOVE:1
T_AMB:27.1
HUM:58
CRY:0
FIRE:0
```

## Commandes envoyeess vers STM32
```txt
SET_RATE:2
ALARM_ACK:1
GET_HR
HR_STREAM:1
```

`SET_RATE:x` = frequence d emission en Hz (1 a 10).

## Seuils d alerte frontend (MVP)
- `CRY:1` ou `FIRE:1` -> alerte immediate
- `HR < 100` ou `HR > 180` -> alerte
- `T_BODY < 36.0` ou `T_BODY > 37.8` -> alerte

## Fichiers
- `index.html`: interface
- `styles.css`: style responsive
- `app.js`: API bridge + polling + alarme
- `bridge_server.py`: pont Python USB serie + API HTTP
- `docs/protocol.txt`: protocole texte
- `docs/stm32-guide.txt`: integration STM32
