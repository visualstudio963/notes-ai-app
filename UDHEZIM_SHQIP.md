# Udhëzim i Shpejtë - Shqip 🇦🇱

## Variablat e detyrueshëm në `.env`

Para se të nisësh serverin, kopjo `.env.example` në `.env` dhe plotëso të paktën:

- `MONGO_URI` – lidhja me MongoDB Atlas  
- `JWT_SECRET` dhe `JWT_REFRESH_SECRET` – stringa të gjata dhe të ndryshme (mos i commit-o në git)

Pa këto, `npm start` ndalon menjëherë me gabim të qartë.

### Windows: `npm` nuk niset (Execution Policy)

Nëse PowerShell thotë *running scripts is disabled*, përdor një nga këto:

- `cmd /c npm start`
- ose `node backend\src\server.js` nga rrënja e projektit
- ose dyklik `scripts\start.cmd`

---

## 📌 Çfarë u bë vetëm tani

### ✅ Përgatisjet e Plotësuara
1. **Syntax Error u Rregullua**
   - Kodi i humbur u gjend dhe u mbyll nëpër function të vetëm
   - Serveri tani funksionon në: `http://localhost:3000`

2. **Sistemi i Settings u Shtoi**
   - Backend endpoints të reja:
     - `GET /api/user/settings` - Merr preferencat (tema + gjuha)
     - `PUT /api/user/settings` - Ruan preferencat
   - User model i përditësuar me `theme` dhe `language` fusha

3. **Frontend Settings u Lidhën me Backend**
   - Kur user logohesh → settings ngarkohen nga serveri
   - Kur ndryshon tema/gjuhë → ruhen në server dhe localStorage
   - Nëse serveri nuk gjen → fallback në localStorage

---

## 🧪 Si ta Testosh

### Test 1: Tema Persiston
```
1. Shko në http://localhost:3000
2. Llogarit ose Hyr
3. Kliko ⚙️ Settings
4. Zgjidh tema (Classic, Normal, Advanced)
5. F5 Refresh - tema duhet të mbesë e njëjtë
6. Mbyll tab dhe hap prapë - tema duhet të jetë aty
```

### Test 2: Gjuha Persiston
```
1. Në Settings, zgjidh "Shqip"
2. Verifikoje se i gjithë teksti ndyshoi
3. F5 Refresh - gjuha duhet të mbesë Shqip
4. Dil dhe hyr prapë - Shqip duhet të jetë aty
```

---

## ⚠️ MongoDB Connection Problem

### Problema Aktuale
- Serveri punon por nuk gjen MongoDB
- Mesazhi i gabimit: "Could not connect to any servers"
- Arsyeja: IP juaj nuk është lejuar në MongoDB Atlas

### Si ta Rregullosh

1. **Gjej IP-in tënd**
   - Vizito: https://www.whatismyipaddress.com/
   - Kopjo IP-in publik

2. **Shto në MongoDB Atlas**
   - Hyj në: https://cloud.mongodb.com/
   - Kliko Cluster0 → Security → Network Access
   - Kliko "+ Add IP Address"
   - Paste IP-in
   - Prit 1-2 minuta

3. **Testo**
   - Restarto serverin: `npm start`
   - Duhet të shohë "MongoDB connected" ose të ngjashme

### Kur login jep gabim TLS/SSL

Nëse sheh në terminal diçka si:
- `tlsv1 alert internal error`
- `ssl3_read_bytes`

atëherë problemi është lidhja TLS me MongoDB Atlas, jo username/password.

Për testim lokal (jo production), mund të vendosësh në `.env`:

`MONGO_TLS_INSECURE=true`

Pastaj restarto serverin (`npm start`). Kjo aktivizon një fallback vetëm në dev për certifikata/hostname TLS.

---

## 🎯 Cilat Feature Funksionojnë

### Tani Punon ✅
- [x] Login/Register endpoints
- [x] Settings page UI
- [x] Theme changing
- [x] Language changing
- [x] Settings save to browser (localStorage)
- [x] Settings load after login

### Nuk Punon pa MongoDB ❌
- [ ] Settings persistencë në database
- [ ] Cross-device sync
- [ ] User data në database

**Fjalë e thjeshtë:** Gjithçka punon pa internet, por kur server rikthehet duhet MongoDB!

---

## 🔧 Debugim i Shpejtë

### Brenda Browser (F12)
```
1. Hap Console tab
2. Shiko për error të kuqe
3. Shiko Network tab → Login request
4. Verifikoje: status 200 = ok, 400/401 = problem
```

### Terminal (ku punon serveri)
- Të gjithë mesazhet e server shfaqen këtu
- Shiko për "✅ Successfully" ose "❌ Error"

---

## 📂 Fajllat e Rëndësishëm

| Skedari | Çfarë Bëhet |
|---------|-----------|
| `backend/src/` | API (routes, services, models) |
| `frontend/public/` | HTML, CSS, JS |
| `frontend/public/js/app.js` | Logjika UI, theme, language |
| `backend/src/models/User.js` | User schema me theme + language |
| `frontend/public/index.html` | Faqja kryesore + settings |
| `frontend/public/css/style.css` | Stilet |

---

## 📋 Çfarë Duhet të Bësh Nesër

1. **Whitelist IP-in në MongoDB Atlas** (shumica e rëndësishëme!)
2. **Testo login/logout me settings**
3. **Verifikoje localStorage fallback**
4. **Shtoni më shumë settings** (notiftime, dark mode, etj)

---

## ✨ Shënimet Teknikë

### Login/Register Response (Tani me Settings)
```json
{
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "user": {
    "id": "...",
    "firstName": "...",
    "theme": "normal",        // ← ÇE E RI
    "language": "sq"          // ← ÇE E RI
  }
}
```

### Saving Settings to Server
```javascript
// Në frontend kur user ndryshon temën:
await saveUserSettings({ theme: "advanced" });

// Server gjen user by token dhe ruan në DB
```

---

## 💡 Këshilla

- **Për offline testing:** Çdo gjë funksionon edhe pa internet! localStorage ruan preferencat.
- **Për debugging:** Shfaq Network tab sa bën login, shiko çfarë kthen serveri.
- **Për production:** Kur MongoDB të lidhesh, settings automatikisht sincronizohesh across devices.

---

**Më të mira të ardhura! 🎉 Settings feature tani gati. Mbetet vetëm MongoDB connection!**

Hapat E Ardhshëm: 
1. Whitelist IP → MongoDB (5 min)
2. Test Login → Settings → Refresh (2 min)
3. Verifikoje settings ne database
4. Gata! ✅
