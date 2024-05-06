const { Telegraf, Markup } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./db/database.sqlite', sqlite3.OPEN_READWRITE, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

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
    // Send the request for phone number message
    ctx.reply("Please share your phone number to proceed:", Markup.keyboard([
        Markup.button.contactRequest("Send my phone number")
    ]).oneTime().resize())
        .then(sentMessage => {
            // Store the message ID for later deletion
            carts[ctx.chat.id].messageIds.push(sentMessage.message_id);
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
}

const bot = new Telegraf('7041878461:AAG9-ngE2VQi3Qb0HFUPMdfK97H0Jqniyus');
const carts = {};

bot.start((ctx) => {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id; // Store the initial message ID
    const username = ctx.from.username;
    ensureCartInitialization(chatId);

    // Check if user's phone number is already stored in the database
    db.get("SELECT phone_number FROM users WHERE chat_id = ?", [chatId], (err, row) => {
        if (err) {
            console.error(err.message);
            return ctx.reply("Failed to retrieve user information.");
        }

        if (row && row.phone_number) {
            // Phone number already exists in the database
            const currentPhoneNumber = row.phone_number;
            ctx.reply(`Your current phone number is: ${currentPhoneNumber}. Is this the correct number?`, Markup.inlineKeyboard([
                Markup.button.callback('Yes', 'confirm_phone'),
                Markup.button.callback('No, I want to use a different number', 'change_phone')
            ])).then(sentMessage => {
                // Store the message ID for later editing
                carts[chatId].messageId = sentMessage.message_id;
                console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
            });
        } else {
            // Request phone number from the user
            requestPhoneNumber(ctx).then(sentMessage => {
                // Store the message ID for later deletion
                carts[chatId].messageIds.push(sentMessage.message_id);
                console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
            });
        }
    });

    // Store the initial message ID
    carts[chatId].messageId = messageId;
});

bot.action('confirm_phone', (ctx) => {
    ctx.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, null, "Great! Your current phone number is confirmed.", mainMenu())
        .catch(error => console.error('Error editing message', error));
});

bot.action('change_phone', (ctx) => {
    // Request phone number from the user
    requestPhoneNumber(ctx);
});



function mainMenu() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('Browse All Wines', 'show_all_wines')],
        [Markup.button.callback('Browse Red Wines', 'show_red'), Markup.button.callback('Browse White Wines', 'show_white')],
        [Markup.button.callback('View My Cart', 'view_cart')],
        [Markup.button.callback('Submit Order', 'submit_order')]
    ]);
}

bot.action(/^show_(.+)$/, (ctx) => {
    const type = ctx.match[1].replace('all_wines', ''); // Normalize type to empty if 'all_wines'
    listWines(ctx, type);
});

bot.on('contact', (ctx) => {
    const phoneNumber = ctx.message.contact.phone_number;
    const username = ctx.from.username;
    storePhoneNumber(ctx.from.id, username, phoneNumber);
    ctx.reply("Phone number received! You can now start ordering.", mainMenu());
});

let lastQueryType = {}; // Store the last query type for each user

async function listWines(ctx, type) {
    ensureCartInitialization(ctx.chat.id);
    lastQueryType[ctx.chat.id] = type; // Store last type used
    let query = "SELECT id, name, price FROM wines";
    let params = [];

    if (type) {
        query += " WHERE type = ?";
        params.push(type);
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error(err.message);
            return ctx.reply("Failed to retrieve wines.");
        }
        let message = type ? `Select a ${type} wine to add to your cart:` : "Select a wine to add to your cart:";
        message += formatCartSummary(ctx.chat.id); // Append current cart summary

        const buttons = rows.map(row => [
            Markup.button.callback(`${row.name} - $${row.price.toFixed(2)}`, `add_${row.id}`)
        ]);
        buttons.push([Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]);

        if (carts[ctx.chat.id].messageId) {
            ctx.telegram.editMessageText(ctx.chat.id, carts[ctx.chat.id].messageId, null, message, Markup.inlineKeyboard(buttons))
                .catch(error => console.error('Error editing message', error));
            console.log(`Message edited. Message ID: ${carts[ctx.chat.id].messageId}`);
        } else {
            ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons)).then(sentMessage => {
                carts[ctx.chat.id].messageId = sentMessage.message_id; // Store the message ID
                console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
            });
        }
    });
}

function formatCartSummary(chatId) {
    if (!carts[chatId] || carts[chatId].items.length === 0) {
        return "\n\nYour cart is currently empty.";
    }
    let summary = "\n\nCurrent Cart:\n";
    carts[chatId].items.forEach((item, index) => {
        summary += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
    });
    return summary;
}




bot.action('back_to_main_menu', (ctx) => {
    ensureCartInitialization(ctx.chat.id);
    // Check if the message ID exists to edit it, otherwise, fall back to sending a new message
    if (carts[ctx.chat.id].messageId) {
        ctx.telegram.editMessageText(ctx.chat.id, carts[ctx.chat.id].messageId, null, "Choose an option:", mainMenu())
            .catch(error => {
                console.error('Error editing message to main menu', error);
                ctx.reply("Choose an option:", mainMenu());
            });
        console.log(`Message edited. Message ID: ${carts[ctx.chat.id].messageId}`);
    } else {
        ctx.reply("Choose an option:", mainMenu()).then(sentMessage => {
            carts[ctx.chat.id].messageId = sentMessage.message_id; // Store the message ID
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
    }
});

bot.action('view_cart', (ctx) => {
    showCart(ctx);
});

bot.on('text', (ctx) => {
    clearPreviousMessages(ctx, ctx.chat.id);
    if (/^[^;]+;[^;]+;.+$/i.test(ctx.message.text)) {
        submitOrder(ctx, ctx.message.text);
    } else {
        ctx.reply("Sorry, I didn't understand that. Please use the buttons to navigate.");
    }
});

bot.action(/^add_(\d+)$/, (ctx) => {
    const wineId = ctx.match[1];
    addToCart(ctx, wineId);
    ctx.answerCbQuery('Added to cart!');
});

function showCart(ctx) {
    const chatId = ctx.chat.id;
    ensureCartInitialization(chatId);
    if (carts[chatId].items.length === 0) {
        ctx.reply("Your cart is empty.", mainMenu());
        return;
    }
    let message = "Your Cart:\n";
    const buttons = [];
    carts[chatId].items.forEach((item, index) => {
        message += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
        buttons.push([
            Markup.button.callback('+', `increase_${item.id}`),
            Markup.button.callback('-', `decrease_${item.id}`),
        ]);
    });
    message += "\nPress 'Submit Order' when you're ready to place your order.";
    buttons.push([Markup.button.callback('Submit Order', 'submit_order'), Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]);
    if (carts[chatId].messageId) {
        ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, message, Markup.inlineKeyboard(buttons))
            .catch(error => {
                console.error("Failed to edit cart message: ", error);
                ctx.reply("Your cart is empty.", mainMenu());
            });
        console.log(`Message edited. Message ID: ${carts[chatId].messageId}`);
    } else {
        ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons)).then(sentMessage => {
            carts[chatId].messageId = sentMessage.message_id;
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        });
    }
}

function ensureCartInitialization(chatId) {
    if (!carts[chatId]) {
        carts[chatId] = { items: [], messageId: null, messageIds: [] };
    }
}


function addToCart(ctx, wineId) {
    ensureCartInitialization(ctx.chat.id);
    db.get("SELECT id, name, price FROM wines WHERE id = ?", [wineId], (err, row) => {
        if (err) {
            console.error(err.message);
            return ctx.reply("Failed to retrieve wine information.");
        }
        const existingItem = carts[ctx.chat.id].items.find(item => item.id === row.id);
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            carts[ctx.chat.id].items.push({
                id: row.id,
                name: row.name,
                price: row.price,
                quantity: 1
            });
        }
        ctx.answerCbQuery(`${row.name} added to cart.`);
        listWines(ctx, lastQueryType[ctx.chat.id]); // Optionally update the list with cart summary
    });
}
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


function increaseCartItem(ctx, wineId) {
    const chatId = ctx.chat.id;
    const item = carts[chatId].items.find(item => item.id === wineId);
    if (item) {
        item.quantity++;
        updateCartMessage(ctx, chatId);
    }
}

function decreaseCartItem(ctx, wineId) {
    const chatId = ctx.chat.id;
    const item = carts[chatId].items.find(item => item.id === wineId);
    if (item && item.quantity > 1) {
        item.quantity--;
        updateCartMessage(ctx, chatId);
    } else if (item && item.quantity === 1) {
        removeFromCart(ctx, wineId); // Remove if count goes to zero
    }
}

function removeFromCart(ctx, wineId) {
    const chatId = ctx.chat.id;
    carts[chatId].items = carts[chatId].items.filter(item => item.id !== wineId);
    updateCartMessage(ctx, chatId);
}


function updateCartMessage(ctx, chatId) {
    if (!carts[chatId].items.length) {
        ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, "Your cart is empty.", mainMenu()).catch(error => {
            console.error("Failed to edit message: ", error);
            // If editing fails, log the error and send a new message instead
            ctx.reply("Your cart is empty.", mainMenu());
        });
        console.log(`Message edited. Message ID: ${carts[chatId].messageId}`);
        return;
    }
    let message = "Your Cart:\n";
    const buttons = [];
    carts[chatId].items.forEach((item, index) => {
        message += `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}\n`;
        buttons.push([
            Markup.button.callback('+', `increase_${item.id}`),
            Markup.button.callback('-', `decrease_${item.id}`),
        ]);
    });
    message += "\nPress 'Submit Order' when you're ready to place your order.";
    buttons.push([Markup.button.callback('Submit Order', 'submit_order'), Markup.button.callback('Back to Main Menu', 'back_to_main_menu')]);
    // Check if the message ID exists and is valid before attempting to edit
    if (carts[chatId].messageId) {
        ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, message, Markup.inlineKeyboard(buttons)).then(() => {
            console.log(`Message edited. Message ID: ${carts[chatId].messageId}`);
        }).catch(error => {
            console.error("Failed to edit message: ", error);
            // If editing fails, log the error and send a new message instead
            ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons));
        });
    } else {
        // If the message ID is not found, send a new message with the cart details
        ctx.replyWithHTML(message, Markup.inlineKeyboard(buttons)).then(sentMessage => {
            carts[chatId].messageId = sentMessage.message_id; // Store the message ID
            console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
        }).catch(error => {
            console.error("Failed to send message: ", error);
        });
    }
}


bot.action('submit_order', (ctx) => {
    const chatId = ctx.chat.id;
    if (!carts[chatId] || carts[chatId].items.length === 0) {
        ctx.reply("Your cart is empty.");
        return;
    }

    submitOrder(ctx, chatId);
});


function submitOrder(ctx, chatId) {
    // Retrieve customer name and phone number from the context or database
    const customerName = ctx.from.username;
    const selectQuery = "SELECT phone_number FROM users WHERE chat_id = ?";
    db.get(selectQuery, [chatId], (err, user) => {
        if (err) {
            console.error(err.message);
            ctx.reply("Failed to retrieve user information.");
            return;
        }
        if (!user) {
            ctx.reply("No phone number found in our records.");
            return;
        }

        // Proceed with order insertion
        db.run("INSERT INTO orders (customer_name, telegram_id) VALUES (?, ?)", [customerName, chatId], function(err) {
            if (err) {
                console.error(err.message);
                ctx.reply("Failed to submit order.");
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
                const confirmationMessage = `Thank you for your order! We will contact you soon at this number: ${user.phone_number}, order number: ${orderId}`;

                // Send order details to your Telegram
                const orderDetails = `Order ID: ${orderId}\nCustomer Name: ${customerName}\nPhone Number: ${user.phone_number}\n\nItems:\n`;
                const itemDetails = carts[chatId].items.map((item, index) => `${index + 1}. ${item.name} - $${item.price.toFixed(2)} x ${item.quantity}`).join('\n');
                const messageToAdmin = orderDetails + itemDetails;
                // Replace 'YOUR_TELEGRAM_USER_ID' with your Telegram user ID or username
                ctx.telegram.sendMessage('940726359', messageToAdmin);

                // Clear cart
                carts[chatId] = { items: [], messageId: null, messageIds: [] };
                // Edit the menu buttons message to only include the "Start New Order" button
                if (carts[chatId].messageId) {
                    ctx.telegram.editMessageText(chatId, carts[chatId].messageId, null, confirmationMessage, Markup.inlineKeyboard([
                        Markup.button.callback('Start New Order', 'start_new_order')
                    ])).then(() => {
                        // Clear all previous messages and buttons
                        clearPreviousMessages(ctx, chatId);
                    }).catch(error => {
                        console.error("Failed to edit message: ", error);
                        ctx.reply(confirmationMessage, Markup.inlineKeyboard([
                            Markup.button.callback('Start New Order', 'start_new_order')
                        ]));
                        // Clear all previous messages and buttons
                        clearPreviousMessages(ctx, chatId);
                    });
                } else {
                    // If the message ID is not found, send a new message with the confirmation
                    ctx.reply(confirmationMessage, Markup.inlineKeyboard([
                        Markup.button.callback('Start New Order', 'start_new_order')
                    ])).then(sentMessage => {
                        carts[chatId].messageId = sentMessage.message_id; // Store the message ID
                        console.log(`Message sent. Message ID: ${sentMessage.message_id}`);
                        // Clear all previous messages and buttons
                        clearPreviousMessages(ctx, chatId);
                    }).catch(error => {
                        console.error("Failed to send message: ", error);
                    });
                }
            }).catch(err => {
                ctx.reply("An error occurred while processing your order. Please try again.");
            });
        });
    });
}


bot.action('start_new_order', (ctx) => {
    // Clear previous messages and start new order
    clearPreviousMessages(ctx, ctx.chat.id);
    carts[ctx.chat.id] = { items: [], messageId: null, messageIds: [] };
    ctx.reply("Your previous order has been cleared. You can now start a new order.", mainMenu());
});



function clearPreviousMessages(ctx, chatId) {
    // Assuming you have tracked all message IDs in carts[chatId].messageIds (an array of message IDs)
    if (carts[chatId] && carts[chatId].messageIds) {
        carts[chatId].messageIds.forEach(messageId => {
            ctx.telegram.editMessageReplyMarkup(chatId, messageId, null, { });  // Clearing the buttons
        });
    }
}




bot.launch();
