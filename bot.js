const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
const chalk = require('chalk');

// Console styling
const log = {
    info: (msg) => console.log(chalk.blue(`[INFO] ${msg}`)),
    success: (msg) => console.log(chalk.green(`[SUCCESS] ${msg}`)),
    warning: (msg) => console.log(chalk.yellow(`[WARNING] ${msg}`)),
    error: (msg) => console.log(chalk.red(`[ERROR] ${msg}`))
};

// In-memory storage
const rides = new Map();
const users = new Map();
const userSessions = new Map();
const feedbackQueue = new Map();

// Location options with emojis
const PICKUP_LOCATIONS = {
    1: { name: 'Mangalore Airport (IXE)', emoji: '✈️' },
    2: { name: 'Mangalore City', emoji: '🌆' },
    3: { name: 'Mangalore Railway Station', emoji: '🚂' },
    4: { name: 'KSRTC Bus Stand', emoji: '🚌' }
};

const DROP_LOCATIONS = {
    1: { name: 'Tiger Circle', emoji: '🐯' },
    2: { name: 'MIT Main Gate', emoji: '🎓' },
    3: { name: 'KMC', emoji: '🏥' },
    4: { name: 'Manipal Bus Stand', emoji: '🚏' }
};

class Session {
    constructor(userId) {
        this.userId = userId;
        this.state = 'MAIN_MENU';
        this.userData = {};
        this.currentRide = null;
    }
}

class Ride {
    constructor(userId, pickup, drop, date, time, userContact) {
        this.id = Date.now().toString();
        this.creatorId = userId;
        this.pickup = pickup;
        this.drop = drop;
        this.date = date;
        this.time = time;
        this.participants = [{
            userId,
            contact: userContact,
            joinedAt: new Date()
        }];
        this.status = 'OPEN';
        this.maxParticipants = 4;
        this.feedbackCollected = new Set();
    }

    canJoin() {
        return this.status === 'OPEN' && this.participants.length < this.maxParticipants;
    }
}

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        args: ['--no-sandbox'],
        headless: true
    }
});

client.on('qr', (qr) => {
    log.info('QR Code generated:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    log.success('Bot is ready and online!');
});

client.on('message', async (message) => {
    try {
        log.info(`New message from ${message.from}: ${message.body}`);
        const userId = message.from;
        
        if (!userSessions.has(userId)) {
            log.info(`Creating new session for user ${userId}`);
            userSessions.set(userId, new Session(userId));
            await showMainMenu(message);
            return;
        }

        const session = userSessions.get(userId);
        await handleUserInput(message, session);
    } catch (error) {
        log.error(`Error handling message: ${error.message}`);
        await message.reply('❌ Something went wrong. Returning to main menu...');
        await showMainMenu(message);
    }
});

async function handleUserInput(message, session) {
    const input = message.body.trim();
    log.info(`Handling input in state ${session.state}: ${input}`);

    switch (session.state) {
        case 'MAIN_MENU':
            await handleMainMenu(message, session, input);
            break;
        case 'AWAITING_PICKUP':
            await handlePickupSelection(message, session, input);
            break;
        case 'AWAITING_DROP':
            await handleDropSelection(message, session, input);
            break;
        case 'AWAITING_DATE':
            await handleDateSelection(message, session, input);
            break;
        case 'AWAITING_TIME':
            await handleTimeInput(message, session, input);
            break;
        case 'AWAITING_FEEDBACK':
            await handleFeedback(message, session, input);
            break;
    }
}

async function showMainMenu(message) {
    const menuText = `*🚗 MIT Cab Share Connect*\n\n` +
        `Welcome to your trusted cab sharing platform!\n\n` +
        `1️⃣ *Find/Join Cab Share*\n` +
        `2️⃣ *My Active Rides*\n` +
        `3️⃣ *Share Live Location*\n` +
        `4️⃣ *Help & Support*\n\n` +
        `_Reply with number to select_\n\n` +
        `💡 Pro tip: Keep notifications on for instant ride matches!`;
    
    await message.reply(menuText);
    log.info(`Main menu shown to ${message.from}`);
}

async function handleMainMenu(message, session, input) {
    log.info(`Processing main menu selection: ${input}`);
    switch (input) {
        case '1':
            session.state = 'AWAITING_PICKUP';
            const pickupOptions = Object.entries(PICKUP_LOCATIONS)
                .map(([key, loc]) => `${key}. ${loc.emoji} ${loc.name}`)
                .join('\n');
            await message.reply(`*Select Pickup Location:*\n\n${pickupOptions}`);
            break;
        case '2':
            await showUserRides(message, session);
            break;
        case '3':
            await requestLocation(message, session);
            break;
        case '4':
            await showHelp(message, session);
            break;
        default:
            await message.reply('❌ Invalid option. Please select 1-4.');
            await showMainMenu(message);
    }
}

async function handlePickupSelection(message, session, input) {
    if (PICKUP_LOCATIONS[input]) {
        log.info(`User selected pickup location: ${PICKUP_LOCATIONS[input].name}`);
        session.userData.pickup = PICKUP_LOCATIONS[input];
        session.state = 'AWAITING_DROP';
        
        const dropOptions = Object.entries(DROP_LOCATIONS)
            .map(([key, loc]) => `${key}. ${loc.emoji} ${loc.name}`)
            .join('\n');
        await message.reply(`*Select Drop Location:*\n\n${dropOptions}`);
    } else {
        await message.reply('❌ Invalid pickup location. Please select again:');
    }
}

async function handleDropSelection(message, session, input) {
    if (DROP_LOCATIONS[input]) {
        log.info(`User selected drop location: ${DROP_LOCATIONS[input].name}`);
        session.userData.drop = DROP_LOCATIONS[input];
        session.state = 'AWAITING_DATE';
        await message.reply(
            `*Select Travel Date*\n\n` +
            `Enter date in YYYY-MM-DD format\n` +
            `Example: 2025-01-29`
        );
    } else {
        await message.reply('❌ Invalid drop location. Please select again:');
    }
}

async function handleDateSelection(message, session, input) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (dateRegex.test(input)) {
        const selectedDate = moment(input);
        const today = moment();

        if (selectedDate.isBefore(today, 'day')) {
            await message.reply('❌ Please select a future date.');
            return;
        }

        log.info(`User selected date: ${input}`);
        session.userData.date = input;
        session.state = 'AWAITING_TIME';
        await message.reply(
            `*Select Preferred Time*\n\n` +
            `Enter time in 24-hour format (HH:MM)\n` +
            `Example: 14:30 for 2:30 PM\n\n` +
            `_We'll match you with rides 30 minutes before and after._`
        );
    } else {
        await message.reply('❌ Invalid date format. Please use YYYY-MM-DD.');
    }
}

async function handleTimeInput(message, session, input) {
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (timeRegex.test(input)) {
        log.info(`User selected time: ${input}`);
        session.userData.time = input;
        await findOrCreateRide(message, session);
        session.state = 'MAIN_MENU';
    } else {
        await message.reply('❌ Invalid time format. Please use HH:MM (Example: 14:30):');
    }
}

async function findOrCreateRide(message, session) {
    log.info('Searching for matching rides...');
    const matches = findMatchingRides(session.userData);
    
    if (matches.length > 0) {
        const match = matches[0];
        log.success(`Found matching ride: ${match.id}`);
        match.participants.push({
            userId: session.userId,
            contact: message.author || message.from,
            joinedAt: new Date()
        });
        
        await notifyParticipants(match);
    } else {
        log.info('No matches found, creating new ride');
        const newRide = new Ride(
            session.userId,
            session.userData.pickup,
            session.userData.drop,
            session.userData.date,
            session.userData.time,
            message.author || message.from
        );
        rides.set(newRide.id, newRide);
        
        await message.reply(
            `✅ *Ride Request Created!*\n\n` +
            `We'll notify you when we find matching riders.\n\n` +
            `*Your Details:*\n` +
            `📍 From: ${newRide.pickup.emoji} ${newRide.pickup.name}\n` +
            `🎯 To: ${newRide.drop.emoji} ${newRide.drop.name}\n` +
            `📅 Date: ${newRide.date}\n` +
            `⏰ Time: ${newRide.time}`
        );
    }
}

async function notifyParticipants(ride) {
    const participantsList = ride.participants
        .map(p => `- ${p.contact}`)
        .join('\n');

    const notification = 
        `*🎉 Cab Share Match Found!*\n\n` +
        `*Ride Details:*\n` +
        `📍 From: ${ride.pickup.emoji} ${ride.pickup.name}\n` +
        `🎯 To: ${ride.drop.emoji} ${ride.drop.name}\n` +
        `📅 Date: ${ride.date}\n` +
        `⏰ Time: ${ride.time}\n` +
        `👥 Participants: ${ride.participants.length}/4\n\n` +
        `*Contact Details:*\n${participantsList}\n\n` +
        `*Next Steps:*\n` +
        `1. Save contact numbers\n` +
        `2. Create WhatsApp group\n` +
        `3. Share live location\n\n` +
        `_Stay safe! Share ride details with family/friends._`;

    for (const participant of ride.participants) {
        await client.sendMessage(participant.userId, notification);
        log.info(`Notified participant: ${participant.userId}`);
    }
}

function findMatchingRides({ pickup, drop, date, time }) {
    const requestDateTime = moment(`${date} ${time}`, 'YYYY-MM-DD HH:mm');
    
    return Array.from(rides.values()).filter(ride => {
        const rideDateTime = moment(`${ride.date} ${ride.time}`, 'YYYY-MM-DD HH:mm');
        const minutesDiff = Math.abs(requestDateTime.diff(rideDateTime, 'minutes'));
        
        return ride.pickup.name === pickup.name &&
               ride.drop.name === drop.name &&
               ride.date === date &&
               minutesDiff <= 30 &&
               ride.canJoin();
    });
}

// Error handling
client.on('auth_failure', () => {
    log.error('Authentication failed');
});

client.on('disconnected', (reason) => {
    log.error(`Client disconnected: ${reason}`);
});

process.on('unhandledRejection', (error) => {
    log.error(`Unhandled promise rejection: ${error}`);
});

// Initialize the bot
client.initialize();
log.info('Initializing WhatsApp bot...');