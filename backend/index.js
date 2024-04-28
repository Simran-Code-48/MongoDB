const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors')


const app = express();
app.use(bodyParser.json());
app.use(cors())
const port = 3001;


// Connect to MongoDB
const mongodbURL = 'mongodb+srv://simran7009191049:paymentdb@walletcluster0.yqmlfmv.mongodb.net/?retryWrites=true&w=majority&appName=walletCluster0';
mongoose.connect(mongodbURL)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('Failed to connect to MongoDB:', err));

// helper functions
function getBankDetails(bankname){
	if(bankname === "hdfc"){
	  return { id : 1000001, tokenUrl : "http://localhost:3000/hdfcbank.com/tokengeneration/", url:"http://localhost:3000/netbanking.hdfcbank.com/netbanking/"};
	}else if(bankname === "sbi"){
	  return { id : 1000002, url : "netbanking.sbibank.com/netbanking/"};
	}
  }
// Define MongoDB schemas
const userSchema = new mongoose.Schema({
	_id: {type: Number },
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    balance: { type: Number, default: 0 }
});

const transactionSchema = new mongoose.Schema({
	// _id:{type: Number },
    sender: { type: Number},
    receiver: { type: Number},
    amount: { type: Number, required: true },
    date_time: { type: Date, default: Date.now },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    description: { type: String },
    sender_balance: { type: Number, required: true },
    receiver_balance: { type: Number, required: true }
});

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

/// Send money to another person
app.post('/paytm/transfer/:id', async (req, res) => {
    const userId = req.params.id;
    const { receiver_email, amount, password } = req.body;

	console.log({ receiver_email, amount, password })
    // Input validation
    if (!userId || !receiver_email || !amount || amount <= 0 || !password) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    let session; // Declare session variable

    try {
        // Start session
        session = await mongoose.startSession();
        session.startTransaction(); // Start transaction

        // User authentication 
        const user = await User.findOne({ _id: userId, password }).session(session);

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Receiver exists
        const receiver = await User.findOne({ email: receiver_email }).session(session);

        if (!receiver) {
            return res.status(404).json({ error: 'Receiver not found' });
        }

        // Register transaction
        const transaction = new Transaction({
            sender: user._id,
            receiver: receiver._id,
            amount,
            sender_balance: user.balance,
            receiver_balance: receiver.balance,
            description: 'Send Money'
        });

        await transaction.save({ session });

        // Balance checking
        if (user.balance < amount) {
            await transaction.updateOne({ status: 'failed' }).session(session); // Update transaction status
            await session.commitTransaction(); // Commit transaction
            session.endSession(); // End session
            return res.status(200).json({ message: 'Insufficient balance' });
        }

        // Update balances
        user.balance -= amount;
        receiver.balance += amount;

        await Promise.all([user.save({ session }), receiver.save({ session })]);

        // Update transaction status to success
        await transaction.updateOne({ status: 'success' }).session(session);

        // Commit transaction
        await session.commitTransaction();

        res.status(200).json({ message: 'Transaction successful' });
    } catch (error) {
        // Abort transaction on error
        await session.abortTransaction();
        console.error('Error processing transaction:', error);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        // End session
        session.endSession();
    }
});

// Retrieve transactions for a user
app.get('/paytm/transactions/:id', async (req, res) => {
    const userId = req.params.id;

    try {
        // Find transactions where the user is either sender or receiver
        const transactions = await Transaction.find({
            $or: [{ sender: userId }, { receiver: userId }]
        });

        // Format transactions
        const formattedTransactions = await Promise.all(transactions.map(async transaction => {
            const isSender = String(transaction.sender) === userId;
            let description = transaction.description;

            if (description === 'Send Money') {
                if (isSender) {
                    const receiver = await User.findById(transaction.receiver);
                    description = `Send Money to ${receiver.username}`;
                } else {
                    const sender = await User.findById(transaction.sender);
                    description = `Receive Money from ${sender.username}`;
                }
            }

            const date_time = new Date(transaction.date_time);
            const date = date_time.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
            const time = date_time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const amount = isSender ? -transaction.amount : transaction.amount;
            const balance = isSender ? transaction.sender_balance : transaction.receiver_balance;
            const status = transaction.status;

            return { description, date, time, amount, balance, status };
        }));

        res.json(formattedTransactions);
    } catch (error) {
        console.error('Error fetching and formatting transaction data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


app.post('/paytm/addmoney/:id', async (req, res) => {
    const userId = req.params.id;
    const { bankname, amount } = req.body;

    // Input validation
    if (!userId || !bankname || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Assuming you have a function to get bank details based on bank name
    const bank = getBankDetails(bankname);
    let transaction;

    try {
        // Find user by id
        const user = await User.findOne({ _id: userId });

        // If user not found, return error
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Register transaction
        transaction = new Transaction({
            sender: bank.id, // Assuming bank.id is a valid ObjectId
            receiver: user._id,
            amount,
            sender_balance: -amount,
            receiver_balance: user.balance,
            description: 'Add Money'
        });

        // Save transaction
        await transaction.save();

		const bankResponse = await axios.post(bank.tokenUrl, { userId: Number(userId), txnId: transaction._id, amount });
        console.log(bankResponse.data.token);
        const confirmationToken = bankResponse.data.token;
        const redirectionURL = `${bank.url}${confirmationToken}`;
        res.status(200).json({ url: redirectionURL })
    } catch (error) {
        console.error('Error processing transaction:', error);

        // If transaction was created, mark it as failed
        if (transaction) {
            transaction.status = 'failed';
            await transaction.save();
        }

        res.status(500).json({ error: 'Internal server error' });
    }
});
app.post('/paytm/webhook', async (req, res) => {
    try {
        console.log('Received webhook payload:', req.body);
        const { txnId } = req.body;
        const transaction = await Transaction.findOne({ _id: txnId, status: 'pending' });

        if (!transaction) {
            return res.status(404).json({ error: 'Transaction not found or already processed' });
        }

        const { amount, receiver } = transaction;

        try {
            // Begin transaction
            const session = await mongoose.startSession();
            session.startTransaction();

            // Update user balance
            await User.updateOne({ _id: receiver }, { $inc: { balance: amount } });

            // Update transaction status
            await Transaction.updateOne({ _id: txnId }, {
				sender_balance: sender_balance-amount,receiver_balance:receiver_balance+amount, status: 'success' });

            await session.commitTransaction();
            session.endSession();

            res.status(200).json({ message: 'Transaction successful' });
        } catch (e) {
            // Rollback transaction on error
            await session.abortTransaction();
            console.error('Error processing transaction:', e);
            res.status(500).json({ error: 'Internal server error' });
        }
    } catch (error) {
        console.error('Error processing webhook payload:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// Start the server
app.listen(port, () => {
    console.log(`Server is running on PORT ${port}`);
});
