const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const yaml = require('js-yaml');
const fs = require('fs');

const db = new sqlite3.Database('./db/database.sqlite', sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

const bot = new Telegraf('7041878461:AAG9-ngE2VQi3Qb0HFUPMdfK97H0Jqniyus');
const carts = {};
let language = '';
let lastQueryType = {}; // Store the last query type for each user

// Load Hebrew translations
const translations = yaml.load(fs.readFileSync('./locales/he.yml', 'utf8')).hebrew;

function t(key, replacements) {
    let text = translations[key] || key;
    for (const placeholder in replacements) {
        text = text.replace(`%{${placeholder}}`, replacements[placeholder]);
    }
    return text;
}

bot.start((ctx) => {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id; // Store the initial message ID
    const username = ctx.from.username;
    ensureCartInitialization(chatId);

    ctx.reply(t('choose_language'), Markup.inlineKeyboard([
        Markup.button.callback(t('english'), 'select_language_en'),
        Markup.button.callback(t('hebrew'), 'select_language_he')
    ])).then(sentMessage => {
        carts[chatId].messageIds.push(sentMessage.message_id);
        console.log(`Language selection message sent. Message ID: ${sentMessage.message_id}`);
    });

    carts[chatId].messageId = messageId;
});

bot.action('select_language_en', (ctx) => {
    language = 'en';
    checkPhoneNumber(ctx);
});

bot.action('select_language_he', (ctx) => {
    language = 'he';
    checkPhoneNumber(ctx);
});

bot.action('confirm_phone', (ctx) => {
    ctx.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, null, t('phone_received'), mainMenu())
        .catch(error => console.error('Error editing message', error));
});

bot.action('change_phone', (ctx) => {
    requestPhoneNumber(ctx);
});

bot.action(/^show_(.+)$/, (ctx) => {
    const type = ctx.match[1].replace('all_wines', '');
    listWines(ctx, type);
});

bot.on('contact', (ctx) => {
    const phoneNumber = ctx.message.contact.phone_number;
    const username = ctx.from.username;
    storePhoneNumber(ctx.from.id, username, phoneNumber);
    ctx.reply(t('phone_received'), mainMenu());
});

bot.action('back_to_main_menu', (ctx) => {
    ensureCartInitialization(ctx.chat.id);
    if (carts[ctx.chat.id].messageId) {
        ctx.telegram.editMessageText(ctx.chat.id, carts[ctx.chat.id].messageId, null, t('choose_language'), mainMenu())
            .catch(error => {
                console.error('Error editing message to main menu', error);
                ctx.reply(t('choose_language'), mainMenu());
            });
        console.log(`Message edited. Message ID: ${carts[ctx.chat.id].messageId}`);
    } else {
        ctx.reply(t('choose_language'), mainMenu()).then(sentMessage => {
            carts[ctx.chat.id].messageId = sentMessage.message_id;
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
    }
});

bot.action('start_new_order', (ctx) => {
    clearPreviousMessages(ctx, ctx.chat.id);
    carts[ctx.chat.id] = { items: [], messageId: null, messageIds: [] };
    ctx.reply(t('new_order_cleared'), mainMenu()).catch(error => {
        console.error("Failed to start a new order: ", error);
        if (error.description === 'Bad Request: chat not found') {
            console.log('Chat not found. Make sure the user has started a chat with the bot.');
        }
    });
});


bot.action('view_cart', (ctx) => {
    showCart(ctx);
});

bot.on('text', (ctx) => {
    clearPreviousMessages(ctx, ctx.chat.id);
    if (/^[^;]+;[^;]+;.+$/i.test(ctx.message.text)) {
        submitOrder(ctx, ctx.message.text);
    } else {
        ctx.reply(t('sorry_not_understood'));
    }
});

bot.action('submit_order', (ctx) => {
    // Assuming that you use chatId from the context directly
    submitOrder(ctx, ctx.chat.id);
});


bot.action(/^add_(\d+)$/, (ctx) => {
    const wineId = ctx.match[1];
    addToCart(ctx, wineId);
    ctx.answerCbQuery(t('wine_added', { wine: wineId }));
});

bot.action(/^increase_(\d+)$/, (ctx) => {
    const wineId = parseInt(ctx.match[1]);
    increaseCartItem(ctx, wineId);
    ctx.answerCbQuery();
});

bot.action(/^decrease_(\d+)$/, (ctx) => {
    const wineId = parseInt(ctx.match[1]);
    decreaseCartItem(ctx, wineId);
    ctx.answerCbQuery();
});

bot.action('start_new_order', (ctx) => {
    clearPreviousMessages(ctx, ctx.chat.id);
    carts[ctx.chat.id] = { items: [], messageId: null, messageIds: [] };
    ctx.reply(t('new_order_cleared'), mainMenu());
});

function formatCartSummary(chatId) {
    if (!carts[chatId] || carts[chatId].items.length === 0) {
        return t('empty_cart');
    }
    let summary = t('cart_current');
    carts[chatId].items.forEach((item, index) => {
        summary += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
    });
    return summary;
}

async function listWines(ctx, type) {
    ensureCartInitialization(ctx.chat.id);
    lastQueryType[ctx.chat.id] = type;
    let query = "SELECT id, name, price FROM wines";
    let params = [];

    if (type) {
        query += " WHERE type = ?";
        params.push(type);
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error(err.message);
            return ctx.reply(t('order_failed'));
        }
        let message = type ? t('browse_wines', { type }) : t('browse_all_wines');
        message += formatCartSummary(ctx.chat.id);

        const buttons = rows.map(row => [
            Markup.button.callback(`${row.name} - $${row.price.toFixed(2)}`, `add_${row.id}`)
        ]);
        buttons.push([Markup.button.callback(t('back_to_main_menu'), 'back_to_main_menu')]);

        if (carts[ctx.chat.id].messageId) {
            ctx.telegram.editMessageText(ctx.chat.id, carts[ctx.chat.id].messageId, null, message, Markup.inlineKeyboard(buttons))
                .then(() => {
                    console.log(`Message edited. Message ID: ${carts[ctx.chat.id].messageId}`);
                })
                .catch(error => {
                    console.error('Error editing message:', error);
                    ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons))
                        .then(sentMessage => {
                            carts[ctx.chat.id].messageId = sentMessage.message_id;
                            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
                        })
                        .catch(error => {
                            console.error("Failed to send message:", error);
                        });
                });
        } else {
            ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons))
                .then(sentMessage => {
                    carts[ctx.chat.id].messageId = sentMessage.message_id;
                    console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
                })
                .catch(error => {
                    console.error("Failed to send message:", error);
                });
        }
    });
}


function submitOrder(ctx, chatId) {
    const customerName = ctx.from.username;
    const selectQuery = "SELECT phone_number FROM users WHERE chat_id = ?";

    db.get(selectQuery, [chatId], (err, user) => {
        if (err) {
            console.error(err.message);
            ctx.reply(t('order_failed'));
            return;
        }
        if (!user) {
            ctx.reply(t('no_phone_found'));
            return;
        }

        db.run("INSERT INTO orders (customer_name, telegram_id) VALUES (?, ?)", [customerName, chatId], function(err) {
            if (err) {
                console.error(err.message);
                ctx.reply(t('order_failed'));
                return;
            }
            const orderId = this.lastID;

            const promises = carts[chatId].items.map(item => {
                return new Promise((resolve, reject) => {
                    db.run("INSERT INTO order_items (order_id, wine_id, quantity) VALUES (?, ?, ?)", [orderId, item.id, item.quantity], (err) => {
                        if (err) {
                            console.error(err.message);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            });

            Promise.all(promises).then(() => {
                const itemDetails = carts[chatId].items.map((item, index) => `${index + 1}. ${item.name} - ₪${item.price.toFixed(2)} x ${item.quantity}`).join('\n');
                const confirmationMessage = t('order_thanks', { phone: user.phone_number, order_id: orderId });
                const messageToAdmin = t('order_details', { order_id: orderId, customer_name: customerName, phone: user.phone_number, items: itemDetails });

                ctx.telegram.sendMessage('429484051', messageToAdmin); // Replace YOUR_TELEGRAM_USER_ID with actual ID

                carts[chatId] = { items: [], messageId: null, messageIds: [] };
                if (carts[chatId].messageId) {
                    ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, confirmationMessage, Markup.inlineKeyboard([
                        Markup.button.callback(t('start_new_order'), 'start_new_order')
                    ])).then(() => {
                        clearPreviousMessages(ctx, chatId);
                    }).catch(error => {
                        console.error("Failed to edit message: ", error);
                        ctx.reply(confirmationMessage, Markup.inlineKeyboard([
                            Markup.button.callback(t('start_new_order'), 'start_new_order')
                        ]));
                        clearPreviousMessages(ctx, chatId);
                    });
                } else {
                    ctx.reply(confirmationMessage, Markup.inlineKeyboard([
                        Markup.button.callback(t('start_new_order'), 'start_new_order')
                    ])).then(sentMessage => {
                        carts[chatId].messageId = sentMessage.message_id;
                        clearPreviousMessages(ctx, chatId);
                    }).catch(error => {
                        console.error("Failed to send message: ", error);
                    });
                }
            }).catch(err => {
                ctx.reply(t('order_failed'));
            });
        });
    });
}





function clearPreviousMessages(ctx, chatId) {
    // Assuming you have tracked all message IDs in carts[chatId].messageIds (an array of message IDs)
    if (carts[chatId] && carts[chatId].messageIds) {
        carts[chatId].messageIds.forEach(messageId => {
            ctx.telegram.editMessageReplyMarkup(chatId, messageId, null, { });  // Clearing the buttons
        });
    }
}



function showCart(ctx) {
    const chatId = ctx.chat.id;
    ensureCartInitialization(chatId);
    if (carts[chatId].items.length === 0) {
        ctx.reply(t('empty_cart'), mainMenu());
        return;
    }
    let message = t('cart_items');
    const buttons = [];
    carts[chatId].items.forEach((item, index) => {
        message += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
        buttons.push([
            Markup.button.callback('+', `increase_${item.id}`),
            Markup.button.callback('-', `decrease_${item.id}`),
        ]);
    });
    message += "\n" + t('press_submit');
    buttons.push([Markup.button.callback(t('submit_order'), 'submit_order'), Markup.button.callback(t('back_to_main_menu'), 'back_to_main_menu')]);
    if (carts[chatId].messageId) {
        ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, message, Markup.inlineKeyboard(buttons))
            .catch(error => {
                console.error("Failed to edit cart message: ", error);
                ctx.reply(t('empty_cart'), mainMenu());
            });
        console.log(`Message edited. Message ID: ${carts[chatId].messageId}`);
    } else {
        ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons)).then(sentMessage => {
            carts[chatId].messageId = sentMessage.message_id;
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
    }
}

function mainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback(t('browse_all_wines'), 'show_all_wines')],
        [Markup.button.callback(t('browse_red_wines'), 'show_red'), Markup.button.callback(t('browse_white_wines'), 'show_white')],
        [Markup.button.callback(t('view_cart'), 'view_cart')],
        [Markup.button.callback(t('submit_order'), 'submit_order')]
    ]);
}






function ensureCartInitialization(chatId) {
    if (!carts[chatId]) {
        carts[chatId] = { items: [], messageId: null, messageIds: [] };
    }
}


function increaseCartItem(ctx, wineId) {
    const chatId = ctx.chat.id;
    const item = carts[chatId].items.find(item => item.id === wineId);
    if (item) {
        item.quantity++;
        updateCartMessage(ctx, chatId);
    }
    ctx.answerCbQuery();
}

function decreaseCartItem(ctx, wineId) {
    const chatId = ctx.chat.id;
    const item = carts[chatId].items.find(item => item.id === wineId);
    if (item && item.quantity > 1) {
        item.quantity--;
        updateCartMessage(ctx, chatId);
    } else if (item && item.quantity === 1) {
        removeFromCart(ctx, wineId);
    }
}

function removeFromCart(ctx, wineId) {
    const chatId = ctx.chat.id;
    carts[chatId].items = carts[chatId].items.filter(item => item.id !== wineId);
    updateCartMessage(ctx, chatId);
}

function updateCartMessage(ctx, chatId) {
    if (!carts[chatId].items.length) {
        ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, t('empty_cart'), mainMenu()).catch(error => {
            console.error("Failed to edit message: ", error);
            ctx.reply(t('empty_cart'), mainMenu());
        });
        console.log(`Message edited. Message ID: ${carts[chatId].messageId}`);
        return;
    }
    let message = t('cart_items');
    const buttons = [];
    carts[chatId].items.forEach((item, index) => {
        message += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
        buttons.push([
            Markup.button.callback('+', `increase_${item.id}`),
            Markup.button.callback('-', `decrease_${item.id}`),
        ]);
    });
    message += "\n" + t('press_submit');
    buttons.push([Markup.button.callback(t('submit_order'), 'submit_order'), Markup.button.callback(t('back_to_main_menu'), 'back_to_main_menu')]);
    ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, message, Markup.inlineKeyboard(buttons)).catch(error => {
        console.error("Failed to edit message: ", error);
        ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons));
    });
}

function storePhoneNumber(userId, username, phoneNumber) {
    db.run("INSERT INTO users (username, chat_id, phone_number) VALUES (?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET phone_number = excluded.phone_number", [username, userId, phoneNumber], (err) => {
        if (err) {
            console.error(err.message);
            return; // Handle error appropriately
        }
        console.log(`Phone number ${phoneNumber} for user ${username} stored successfully.`);
    });
}

function requestPhoneNumber(ctx) {
    ctx.reply(t('share_phone'), Markup.keyboard([
        Markup.button.contactRequest(t('send_phone'))
    ]).oneTime().resize())
        .then(sentMessage => {
            carts[ctx.chat.id].messageIds.push(sentMessage.message_id);
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
}

function checkPhoneNumber(ctx) {
    const chatId = ctx.chat.id;
    const username = ctx.from.username;
    db.get("SELECT phone_number FROM users WHERE chat_id = ?", [chatId], (err, row) => {
        if (err) {
            console.error(err.message);
            return ctx.reply("Failed to retrieve user information.");
        }

        if (row && row.phone_number) {
            ctx.editMessageText(t('confirm_phone', { phone: row.phone_number }), Markup.inlineKeyboard([
                Markup.button.callback(t('yes'), 'confirm_phone'),
                Markup.button.callback(t('no_change_number'), 'change_phone')
            ])).catch(error => {
                console.error('Error editing message', error);
            });
        } else {
            ctx.reply(t('share_phone'), Markup.keyboard([
                Markup.button.contactRequest(t('send_phone'))
            ]).oneTime().resize())
                .then(sentMessage => {
                    carts[ctx.chat.id].messageIds.push(sentMessage.message_id);
                    console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
                });
        }
    });
}


function addToCart(ctx, wineId) {
    ensureCartInitialization(ctx.chat.id);  // Ensure cart is initialized for the user

    // Query the database to get wine details by ID
    db.get("SELECT id, name, price FROM wines WHERE id = ?", [wineId], (err, row) => {
        if (err) {
            console.error(err.message);
            return ctx.reply("Failed to retrieve wine information.");  // Handle database errors
        }

        // Find if the wine is already added in the cart
        const existingItem = carts[ctx.chat.id].items.find(item => item.id === row.id);

        if (existingItem) {
            // If found, increment the quantity
            existingItem.quantity += 1;
        } else {
            // If not found, add the new item to the cart
            carts[ctx.chat.id].items.push({
                id: row.id,
                name: row.name,
                price: row.price,
                quantity: 1
            });
        }

        // Provide feedback to the user
        ctx.answerCbQuery(`${row.name} added to cart.`);
        
        // Optionally refresh the wine list or the cart view
        listWines(ctx, lastQueryType[ctx.chat.id]);  // Update the list with cart summary
    });
}



bot.launch();