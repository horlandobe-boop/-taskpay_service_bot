
import TelegramBot from 'node-telegram-bot-api';
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, query, where, getDocs, increment } from "firebase/firestore";
import sharp from 'sharp';
import fetch from 'node-fetch'; // Ilaina raha Node version taloha, fa Node 18+ dia efa manana fetch native.

// 1. CONFIGURATION
// Soloy ny Token vaovao azonao any amin'ny BotFather eto
const token = 'YOUR_NEW_BOT_TOKEN_HERE'; 

const firebaseConfig = {
  apiKey: "AIzaSyBqE5CKzZ4k7_gVICN0KpRIa9dJcoqaPuo", // Tandremo ny security
  authDomain: "axiom-invest.firebaseapp.com",
  databaseURL: "https://axiom-invest-default-rtdb.firebaseio.com",
  projectId: "axiom-invest",
  storageBucket: "axiom-invest.firebasestorage.app",
  messagingSenderId: "1027219828712",
  appId: "1:1027219828712:web:65570b565c1f7cd4bc3e5d",
  measurementId: "G-4TXXD8ZEVK"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Initialize Bot
const bot = new TelegramBot(token, { polling: true });

// Variables
const TASK_REWARD = 0.009;
const MIN_WITHDRAWAL = 0.3;
const WITHDRAWAL_FEE = 0.03;
const REFERRAL_PERCENT = 0.10; // 10%

// User States (Mba hahafantarana raha miandry sary na montant ny bot)
const userStates = {}; 

// --- MENU PRINCIPAL ---
const mainMenu = {
    reply_markup: {
        keyboard: [
            ['➡️ Balance', '➡️ Tasks'],
            ['➡️ Retrait', '➡️ Preuve en attente'],
            ['➡️ FAQ', '➡️ RÉFÉRAL']
        ],
        resize_keyboard: true
    }
};

// --- START & REFERRAL LOGIC ---
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const referralCode = match[1]; // Raha avy amin'ny lien parrainage

    const userRef = doc(db, "users", userId);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
        // Mpampiasa vaovao
        let referrerId = null;
        if (referralCode && referralCode !== userId) {
            referrerId = referralCode;
            // Azonao atao ny manamarina raha misy ilay referrer ao amin'ny base
        }

        await setDoc(userRef, {
            username: msg.from.username || "Anonymous",
            firstName: msg.from.first_name,
            balance: 0,
            referredBy: referrerId,
            totalReferrals: 0,
            joinedAt: new Date().toISOString()
        });

        if (referrerId) {
            // Ampiana ny isan'ny olona nentin'ilay parrain
            const refUser = doc(db, "users", referrerId);
            await updateDoc(refUser, { totalReferrals: increment(1) });
        }
    }

    bot.sendMessage(chatId, `Salama ${msg.from.first_name}! Tonga soa ao amin'ny TaskPay. Misafidiana menu :`, mainMenu);
});

// --- LISTENER MESSAGES ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id.toString();

    // Raha mandefa sary (ho an'ny Tâche)
    if (msg.photo && userStates[userId] === 'WAITING_PROOF') {
        handlePhotoUpload(msg, chatId, userId);
        return;
    }

    // Raha manoratra montant (ho an'ny Retrait)
    if (userStates[userId] === 'WAITING_WITHDRAWAL_AMOUNT') {
        handleWithdrawalAmount(msg, chatId, userId);
        return;
    }

    // Raha manoratra adresse USDT
    if (userStates[userId] === 'WAITING_USDT_ADDRESS') {
        handleWithdrawalAddress(msg, chatId, userId);
        return;
    }

    switch (text) {
        case '➡️ Balance':
            showBalance(chatId, userId);
            break;
        case '➡️ Tasks':
            showTasks(chatId, userId);
            break;
        case '➡️ Retrait':
            initiateWithdrawal(chatId, userId);
            break;
        case '➡️ Preuve en attente':
            showPendingProofs(chatId, userId);
            break;
        case '➡️ FAQ':
            showFAQ(chatId);
            break;
        case '➡️ RÉFÉRAL':
            showReferral(chatId, userId);
            break;
    }
});

// --- FONCTIONS ---

// 1. BALANCE
async function showBalance(chatId, userId) {
    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    if (snap.exists()) {
        const data = snap.data();
        bot.sendMessage(chatId, `💰 **Ny Balance-nao:**\n\n💵 Solde: $${data.balance.toFixed(4)}\n👥 Referrals: ${data.totalReferrals}`, { parse_mode: 'Markdown' });
    }
}

// 2. TASKS
async function showTasks(chatId, userId) {
    const message = `📋 **ASA VAOVAO:**\n\n` +
                    `1️⃣ Mamorona compte Instagram.\n` +
                    `2️⃣ Karama: **$${TASK_REWARD}** / asa.\n\n` +
                    `Rehefa vita, tsindrio ny bokotra eto ambany handefasana ny Preuve (Capture d'écran mampiseho ny Nom d'utilisateur sy Date de création).`;
    
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📸 Alefa ny Preuve', callback_data: 'send_proof' }]
            ]
        },
        parse_mode: 'Markdown'
    };
    bot.sendMessage(chatId, message, opts);
}

// 3. HANDLING PROOF (COMPRESSION BASE64)
async function handlePhotoUpload(msg, chatId, userId) {
    bot.sendMessage(chatId, "⏳ Eo am-panodinana ny sary, miandrasa kely...");
    
    try {
        // Raisina ny sary lehibe indrindra
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const fileLink = await bot.getFileLink(fileId);

        // Download image
        const response = await fetch(fileLink);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Compresser sary (Tena ilaina ho an'ny Firestore Base64)
        // Ahena ho 800px ny sakany ary quality 60%
        const compressedBuffer = await sharp(buffer)
            .resize(800) 
            .jpeg({ quality: 60 })
            .toBuffer();

        const base64Image = compressedBuffer.toString('base64');

        // Tehirizina ao amin'ny Firestore
        await addDoc(collection(db, "tasks"), {
            userId: userId,
            status: "pending", // En attente
            reward: TASK_REWARD,
            imageBase64: base64Image,
            createdAt: new Date().toISOString(),
            description: "Création compte Instagram"
        });

        userStates[userId] = null; // Reset state
        bot.sendMessage(chatId, "✅ Voaray ny porofo! Efa ao amin'ny 'Preuve En attente' izy io izao miandry ny validation-n'ny Admin.");

    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, "❌ Nisy olana teo amin'ny fandefasana sary. Avereno azafady.");
    }
}

// 4. PREUVE EN ATTENTE
async function showPendingProofs(chatId, userId) {
    const q = query(collection(db, "tasks"), where("userId", "==", userId), where("status", "==", "pending"));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
        bot.sendMessage(chatId, "📂 Tsy misy asa miandry validation ianao amin'izao fotoana izao.");
    } else {
        let msg = "📂 **Ny Asanao miandry Validation:**\n\n";
        snapshot.forEach((doc) => {
            const data = doc.data();
            msg += `- ${data.description} ($${data.reward}) - ${new Date(data.createdAt).toLocaleDateString()}\n`;
        });
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
}

// 5. RETRAIT
async function initiateWithdrawal(chatId, userId) {
    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    const balance = snap.data().balance;

    if (balance < MIN_WITHDRAWAL) {
        bot.sendMessage(chatId, `⚠️ **Balance Insuffisant!**\n\nNy minimum retrait dia $${MIN_WITHDRAWAL}. Ny volanao: $${balance.toFixed(4)}.\n\nMandehana manao asa hamenoana izany!`, mainMenu);
    } else {
        bot.sendMessage(chatId, `💰 Ohatrinona ny vola tianao halaina? (Minimum: $${MIN_WITHDRAWAL})`);
        userStates[userId] = 'WAITING_WITHDRAWAL_AMOUNT';
    }
}

async function handleWithdrawalAmount(msg, chatId, userId) {
    const amount = parseFloat(msg.text);
    
    // Check raha isa ilay izy
    if (isNaN(amount)) {
        bot.sendMessage(chatId, "⚠️ Isa ihany soratana. Ohatra: 0.5");
        return;
    }

    const userRef = doc(db, "users", userId);
    const snap = await getDoc(userRef);
    const currentBalance = snap.data().balance;

    if (amount < MIN_WITHDRAWAL) {
        bot.sendMessage(chatId, `⚠️ Ny kely indrindra azo alaina dia $${MIN_WITHDRAWAL}.`);
        return;
    }

    if (amount > currentBalance) {
        bot.sendMessage(chatId, `⚠️ **Balance Insuffisant!** Tsy ampy ny volanao. Manaova asa indray.`);
        userStates[userId] = null;
        return;
    }

    // Kajy (Calcul)
    const netAmount = amount - WITHDRAWAL_FEE;
    
    // Tehirizina vonjimaika ny montant
    userStates[userId] = `CONFIRM_WITHDRAWAL_${amount}`;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Continuer', callback_data: `confirm_withdraw_${amount}` }],
                [{ text: '❌ Annuler', callback_data: 'cancel_withdraw' }]
            ]
        },
        parse_mode: 'Markdown'
    };

    bot.sendMessage(chatId, `🧾 **Résumé Retrait:**\n\nMontant nangatahina: $${amount}\nFrais: $${WITHDRAWAL_FEE}\n\n👉 **Vola ho raisinao: $${netAmount.toFixed(4)}**\n\nTe hanohy ve ianao?`, opts);
    userStates[userId] = null; // Reset state text input, miandry callback
}

async function handleWithdrawalAddress(msg, chatId, userId) {
    const address = msg.text;
    const amount = parseFloat(userStates[userId].split(':')[1]); // Retrieve amount from state tag

    // Save request
    await addDoc(collection(db, "withdrawals"), {
        userId: userId,
        amount: amount,
        fee: WITHDRAWAL_FEE,
        netAmount: amount - WITHDRAWAL_FEE,
        address: address,
        status: "pending",
        createdAt: new Date().toISOString()
    });

    // Important: Tsy mbola manala balance eto araka ny fangatahanao.
    // Rehefa manao "Confirm" ny admin vaoesorina.
    
    userStates[userId] = null;
    bot.sendMessage(chatId, `✅ **Demande voaray!**\n\nEo am-pandaminana ny fandoavam-bola ny ekipa. Mety haharitra 5min - 24h izany.\nAzonao jerena ao amin'ny Historique ny satany.`, mainMenu);
}

// 6. FAQ
function showFAQ(chatId) {
    const faq = `📚 **FAQ - Fanontaniana mipetraka matetika**\n\n` +
                `❓ **Ahoana ny fiasan'ny TaskPay?**\n` +
                `Mamorona kaonty Instagram ianao dia mahazo vola.\n\n` +
                `❓ **Ohatrinona ny karama?**\n` +
                `$0.009 isaky ny kaonty iray.\n\n` +
                `❓ **Manao ahoana ny fandoavam-bola?**\n` +
                `Via USDT (BEP20). Minimum $0.3.\n\n` +
                `❓ **Ela ve ny validation?**\n` +
                `Matetika 24h ny fara-fahakeliny.`;
    bot.sendMessage(chatId, faq, { parse_mode: 'Markdown' });
}

// 7. REFERRAL
function showReferral(chatId, userId) {
    const refLink = `https://t.me/${bot.getMe().then(me => me.username).catch(() => 'taskpay_service_bot')}?start=${userId}`;
    
    const msg = `🤝 **Programme de Parrainage**\n\n` +
                `Zarao ny lien-nao ary mahazoa **10%** amin'ny asa vitan'ireo olona nasainao!\n\n` +
                `🔗 **Ny Lien-nao:**\n\`${refLink}\`\n\n` +
                `Ity no rafitra tsara indrindra hampitomboana ny volanao haingana!`;
    
    bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

// --- CALLBACK QUERY HANDLER (Boutons) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id.toString();
    const data = query.data;

    if (data === 'send_proof') {
        userStates[userId] = 'WAITING_PROOF';
        bot.sendMessage(chatId, "📸 Alefaso amin'izay ary ny Capture d'écran-nao (Sary misy ny username sy date).");
    } else if (data.startsWith('confirm_withdraw_')) {
        const amount = data.split('_')[2];
        userStates[userId] = `WAITING_USDT_ADDRESS:${amount}`;
        bot.sendMessage(chatId, "📝 Sorato ny adresse **USDT BEP20** handraisanao ny vola:");
    } else if (data === 'cancel_withdraw') {
        userStates[userId] = null;
        bot.sendMessage(chatId, "❌ Nofoanana ny retrait.", mainMenu);
    }
    
    bot.answerCallbackQuery(query.id);
});

console.log("Bot mandeha...");
