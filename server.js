// ==========================================================================
// Serveur Kalamu — comptes utilisateurs, essai gratuit, abonnement CinetPay
// ==========================================================================
// Ce fichier fait tout ce qu'une page web (le fichier kalamu.html) ne peut
// pas faire elle-même en sécurité : garder des mots de passe, parler à
// CinetPay avec les vraies clés secrètes, et retenir qui a payé.

require("dotenv").config();
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || "3", 10);
const DAY_MS = 24 * 60 * 60 * 1000;

// Les deux formules d'abonnement disponibles
const PLANS = {
  biweekly: { days: 14, amount: 500, label: "2 semaines" },
  monthly: { days: 30, amount: 1000, label: "1 mois" },
};

// ---------------------------------------------------------------------
// Base de données — un simple fichier JSON local (aucune installation
// technique requise, pas de compilation, fonctionne partout).
// ---------------------------------------------------------------------
const DB_FILE = "kalamu-data.json";

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { users: [], payments: [], nextUserId: 1, nextPaymentId: 1 };
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const db = {
  findUserByPhone(phone) {
    return loadDB().users.find((u) => u.phone === phone) || null;
  },
  findUserById(id) {
    return loadDB().users.find((u) => u.id === id) || null;
  },
  createUser({ phone, password_hash, trial_start }) {
    const data = loadDB();
    const user = {
      id: data.nextUserId++,
      phone,
      password_hash,
      trial_start,
      plan: "free",
      premium_until: null,
      is_owner: false,
      created_at: Date.now(),
    };
    data.users.push(user);
    saveDB(data);
    return user;
  },
  setOwner(id) {
    const data = loadDB();
    const user = data.users.find((u) => u.id === id);
    if (user) user.is_owner = true;
    saveDB(data);
    return user;
  },
  setPremium(id, premiumUntil) {
    const data = loadDB();
    const user = data.users.find((u) => u.id === id);
    if (user) {
      user.plan = "premium";
      user.premium_until = premiumUntil;
      user.pending_manual_payment = false;
    }
    saveDB(data);
    return user;
  },
  markPendingManualPayment(id, plan) {
    const data = loadDB();
    const user = data.users.find((u) => u.id === id);
    if (user) {
      user.pending_manual_payment = true;
      user.pending_plan = plan;
      user.manual_payment_at = Date.now();
    }
    saveDB(data);
    return user;
  },
  listPendingManualPayments() {
    return loadDB().users.filter((u) => u.pending_manual_payment === true);
  },
  createPayment({ user_id, transaction_id, plan }) {
    const data = loadDB();
    const payment = {
      id: data.nextPaymentId++,
      user_id,
      transaction_id,
      plan,
      status: "PENDING",
      created_at: Date.now(),
    };
    data.payments.push(payment);
    saveDB(data);
    return payment;
  },
  findPayment(transaction_id) {
    return loadDB().payments.find((p) => p.transaction_id === transaction_id) || null;
  },
  updatePaymentStatus(transaction_id, status) {
    const data = loadDB();
    const payment = data.payments.find((p) => p.transaction_id === transaction_id);
    if (payment) payment.status = status;
    saveDB(data);
  },
};

// ---------------------------------------------------------------------
// Authentification (créer un compte / se connecter)
// ---------------------------------------------------------------------
function signToken(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "180d" });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non connecté." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.findUserById(payload.id);
    if (!user) return res.status(401).json({ error: "Compte introuvable." });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session invalide, reconnecte-toi." });
  }
}

app.post("/api/signup", (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password || password.length < 4) {
    return res.status(400).json({ error: "Numéro et mot de passe (4 caractères min.) requis." });
  }
  const existing = db.findUserByPhone(phone);
  if (existing) return res.status(409).json({ error: "Ce numéro a déjà un compte." });

  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const user = db.createUser({ phone, password_hash: hash, trial_start: now });
  res.json({ token: signToken(user), status: computeStatus(user) });
});

app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  const user = db.findUserByPhone(phone);
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Numéro ou mot de passe incorrect." });
  }
  res.json({ token: signToken(user), status: computeStatus(user) });
});

// ---------------------------------------------------------------------
// Statut du compte (essai en cours, expiré, ou premium)
// ---------------------------------------------------------------------
function computeStatus(user) {
  const now = Date.now();
  if (user.is_owner) return { plan: "premium", reason: "owner" };
  if (user.plan === "premium" && user.premium_until && user.premium_until > now) {
    return { plan: "premium", reason: "subscription", premium_until: user.premium_until };
  }
  const daysElapsed = (now - user.trial_start) / DAY_MS;
  if (daysElapsed < TRIAL_DAYS) {
    return { plan: "trial", daysLeft: Math.max(0, TRIAL_DAYS - daysElapsed) };
  }
  return { plan: "expired" };
}

app.get("/api/status", authMiddleware, (req, res) => {
  res.json({ status: computeStatus(req.user) });
});

// ---------------------------------------------------------------------
// Intelligence artificielle (Claude) — proxy sécurisé
// La clé API reste ici, côté serveur, jamais visible dans le navigateur.
// L'app (kalamu.html) appelle cette route au lieu d'appeler Anthropic
// directement.
// ---------------------------------------------------------------------
app.post("/api/ai", authMiddleware, async (req, res) => {
  const status = computeStatus(req.user);
  if (status.plan === "expired") {
    return res.status(403).json({ error: "Essai terminé, passe en Premium." });
  }
  const { messages, system } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: "Message manquant." });
  }
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        system,
        messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Erreur Anthropic:", data);
      return res.status(502).json({ error: "L'IA n'a pas répondu correctement." });
    }
    const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Impossible de contacter l'IA pour le moment." });
  }
});

// ---------------------------------------------------------------------
// Accès propriétaire (débloque Premium à vie, sans paiement)
// ---------------------------------------------------------------------
app.post("/api/owner-unlock", authMiddleware, (req, res) => {
  const { code } = req.body || {};
  if (!code || code !== process.env.OWNER_CODE) {
    return res.status(403).json({ error: "Code incorrect." });
  }
  db.setOwner(req.user.id);
  const user = db.findUserById(req.user.id);
  res.json({ status: computeStatus(user) });
});

// ---------------------------------------------------------------------
// Paiement CinetPay — initier un paiement
// ---------------------------------------------------------------------
app.post("/api/subscribe/initiate", authMiddleware, async (req, res) => {
  const planKey = PLANS[req.body?.plan] ? req.body.plan : "biweekly";
  const plan = PLANS[planKey];
  const transactionId = `kalamu_${req.user.id}_${Date.now()}`;
  db.createPayment({ user_id: req.user.id, transaction_id: transactionId, plan: planKey });

  try {
    const response = await fetch("https://api-checkout.cinetpay.com/v2/payment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apikey: process.env.CINETPAY_APIKEY,
        site_id: process.env.CINETPAY_SITE_ID,
        transaction_id: transactionId,
        amount: plan.amount,
        currency: "XOF",
        description: `Abonnement Kalamu - ${plan.label}`,
        notify_url: `${process.env.PUBLIC_SERVER_URL}/api/subscribe/notify`,
        return_url: `${process.env.PUBLIC_SERVER_URL}/api/subscribe/return`,
        channels: "MOBILE_MONEY",
        customer_id: String(req.user.id),
        customer_name: "Client",
        customer_surname: "Kalamu",
      }),
    });
    const data = await response.json();
    if (data.code !== "201") {
      return res.status(502).json({ error: "CinetPay a refusé la demande.", details: data });
    }
    res.json({ payment_url: data.data.payment_url });
  } catch (e) {
    res.status(500).json({ error: "Impossible de contacter CinetPay pour le moment." });
  }
});

// ---------------------------------------------------------------------
// Paiement CinetPay — notification automatique après paiement
// ---------------------------------------------------------------------
app.post("/api/subscribe/notify", async (req, res) => {
  const transactionId = req.body.cpm_trans_id;
  if (!transactionId) return res.status(400).end();

  const payment = db.findPayment(transactionId);
  if (!payment) return res.status(404).end();

  try {
    // Étape de sécurité obligatoire : on ne fait JAMAIS confiance à la notification
    // seule. On revérifie directement auprès de CinetPay.
    const check = await fetch("https://api-checkout.cinetpay.com/v2/payment/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transaction_id: transactionId,
        site_id: process.env.CINETPAY_SITE_ID,
        apikey: process.env.CINETPAY_APIKEY,
      }),
    });
    const result = await check.json();

    if (result.code === "00" && result.data && result.data.status === "ACCEPTED") {
      db.updatePaymentStatus(transactionId, "ACCEPTED");
      const plan = PLANS[payment.plan] || PLANS.biweekly;
      const newUntil = Date.now() + plan.days * DAY_MS;
      db.setPremium(payment.user_id, newUntil);
    } else {
      db.updatePaymentStatus(transactionId, result.data?.status || "FAILED");
    }
  } catch (e) {
    console.error("Erreur de vérification CinetPay :", e);
  }
  res.status(200).end(); // CinetPay attend juste un 200 OK
});

// ---------------------------------------------------------------------
// Paiement manuel Orange Money — en attendant que CinetPay soit actif.
// L'utilisateur signale qu'il a envoyé l'argent ; le propriétaire valide
// ensuite manuellement depuis l'espace administrateur.
// ---------------------------------------------------------------------
app.post("/api/subscribe/manual-notify", authMiddleware, (req, res) => {
  const planKey = PLANS[req.body?.plan] ? req.body.plan : "biweekly";
  db.markPendingManualPayment(req.user.id, planKey);
  const user = db.findUserById(req.user.id);
  res.json({ status: computeStatus(user) });
});

// ---------------------------------------------------------------------
// Espace administrateur — réservé au propriétaire (is_owner).
// ---------------------------------------------------------------------
function ownerOnly(req, res, next) {
  if (!req.user.is_owner) return res.status(403).json({ error: "Accès réservé au propriétaire." });
  next();
}

app.get("/api/admin/pending", authMiddleware, ownerOnly, (req, res) => {
  const pending = db.listPendingManualPayments().map((u) => ({
    phone: u.phone,
    plan: u.pending_plan || "biweekly",
    plan_label: (PLANS[u.pending_plan] || PLANS.biweekly).label,
    requested_at: u.manual_payment_at,
  }));
  res.json({ pending });
});

app.post("/api/admin/approve", authMiddleware, ownerOnly, (req, res) => {
  const { phone } = req.body || {};
  const user = db.findUserByPhone(phone);
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });
  const plan = PLANS[user.pending_plan] || PLANS.biweekly;
  const newUntil = Date.now() + plan.days * DAY_MS;
  db.setPremium(user.id, newUntil);
  res.json({ ok: true });
});

app.get("/api/subscribe/return", (req, res) => {
  res.send("Merci ! Tu peux retourner sur l'application Kalamu.");
});

app.get("/", (req, res) => res.send("Serveur Kalamu en ligne."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur Kalamu démarré sur le port ${PORT}`));
