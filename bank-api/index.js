const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const jwt = require("jsonwebtoken");

const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const app = express();
const port = 3000;
app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
const mongodbURL = 'mongodb+srv://simran7009191049:paymentdb@walletcluster0.yqmlfmv.mongodb.net/?retryWrites=true&w=majority&appName=walletCluster0';
mongoose.connect(mongodbURL)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Failed to connect to MongoDB:', err));

// Schema for BankUsers
const bankUserSchema = new mongoose.Schema({
    _id: { type: Number, required: true }, // Change type to Number
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    pin: { type: Number, required: true },
    balance: { type: Number, required: true, default: 0 }
});


const bankTransactionSchema = new mongoose.Schema({
    _id: { type: Number, required: true }, // Change type to Number
    sender: { type: Number, required: true },
    receiver: { type: Number, required: true },
    amount: { type: Number, required: true },
    date_time: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    description: { type: String },
    sender_balance: { type: Number, required: true },
    receiver_balance: { type: Number, required: true }
});

// Model for BankUsers
const BankUser = mongoose.model('BankUser', bankUserSchema);

// Model for BankTransactions
const BankTransaction = mongoose.model('BankTransaction', bankTransactionSchema);

//paytm data
const paytm_token = "paytm-hdfc-token";
const paytmAccountId = 1001;
const otherBackendURL = "http://localhost:3001/paytm/webhook"; // Replace with the actual URL
const tokens_amount = [];

// Route for token generation
app.post("/hdfcbank.com/tokengeneration/", async (req, res) => {
    const { userId, txnId, amount } = req.body;
    console.log({ userId, txnId, amount });
    const token = jwt.sign({ userId, txnId, amount: Number(amount) }, paytm_token); // Replace paytm_secret with your actual secret key
    tokens_amount.push({ token, amount, txnId });
    res.status(200).json({ token });
});
app.post("/netbanking.hdfcbank.com/netbanking/:token", async (req, res) => {
    const token = req.params.token;
    let { userBankId, userBankPin } = req.body;
    userBankId = Number(userBankId);
    userBankPin = Number(userBankPin);
    console.log({ userBankId, userBankPin });

    try {
        if (isNaN(userBankId) || !Number.isInteger(userBankId)) {
            return res.status(400).json({ error: "Invalid userBankId" });
        }

        const user = await BankUser.findOne({ _id: userBankId });
        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const tokenEntry = tokens_amount.find((entry) => entry.token === token);
        if (!tokenEntry) {
            return res.status(404).json({ error: "Token not found" });
        }

        const amount = tokenEntry.amount;
        if (user.balance < amount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Get the last transaction
        const lastTransaction = await BankTransaction.findOne().sort({ _id: -1 });

        let lastTransactionId = 0;
        if (lastTransaction) {
            lastTransactionId = lastTransaction._id;
        }

        // Generate new transaction ID by incrementing the last transaction ID
        const newTransactionId = lastTransactionId + 1;

        const transaction = new BankTransaction({
            _id: newTransactionId,
            sender: userBankId,
            receiver: paytmAccountId,
            amount: amount,
            sender_balance: user.balance - amount,
            receiver_balance: user.balance + amount,
            status: "pending",
        });

        await transaction.save();

        // Update sender balance
        await BankUser.updateOne({ _id: userBankId }, { $inc: { balance: -amount } });

        // Update receiver balance
        await BankUser.updateOne({ _id: paytmAccountId }, { $inc: { balance: amount } });

        // Update transaction status
        await BankTransaction.updateOne({ _id: newTransactionId }, { status: "success" });

        await axios.post(otherBackendURL, {
            status: "success",
            txnId: tokenEntry.txnId,
        });

        res.status(200).json({ message: "Transaction successful" });
    } catch (error) {
        console.error("Error processing transaction:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});



app.listen(port, () => {
    console.log("HDFC webhook running on PORT " + port);
});
