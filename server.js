  require("dotenv").config();
  const fs = require("fs");
  const express = require('express');
  const mongoose = require('mongoose');
  const User = require('./models/user');

  const multer = require("multer");
  const pdfParse = require("pdf-parse");
  const Groq = require("groq-sdk");
  const Tesseract = require("tesseract.js");
  const Summary = require("./models/summary");
  const Quiz = require("./models/quiz");
  const Doubt = require("./models/Doubt");
  const bcrypt = require("bcrypt");
  const session = require("express-session");
  const Flashcard = require("./models/flashcard");
  const chat=require("./models/chat");



  const app = express();
  const port = 3000;
  const upload = multer({ storage: multer.memoryStorage() });
  app.set("view engine", "ejs");
  app.set("views", "./views");

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(express.static('public'));


  


// MongoDB connection
const dbURI = process.env.MONGO_URI;

mongoose.connect(dbURI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    // Standard practice to help debug connection issues in production logs
  });

  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
  });

  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  }));

  
  app.get("/login", (req, res) => {
  res.render("login", { error: null }); 
});


  app.get("/",(req,res)=>{
if(req.session.userId){
return res.redirect("/dashboard");
}
res.render("login");
});


app.get("/signup", (req, res) => {
  res.render("signup", { error: null });
});



  app.post("/login", async (req, res) => {

  const { username, password } = req.body;

  const user = await User.findOne({ username });

  if (!user) {
    return res.render("login", { error: "⚠️ User not found. Please sign up first." });
  }

  // compare hashed password
  const match = await bcrypt.compare(password, user.password);

  if (!match) {
    return res.render("login", { error: "⚠️ Incorrect password. Try again." });
  }

  // store user in session
  req.session.userId = user._id;

  res.redirect("/dashboard");

  });
  app.post("/signup", async (req, res) => {

  const { username, email, password } = req.body;

  // hash password
  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = new User({
    username,
    email,
    password: hashedPassword
  });

  await newUser.save();

  // login user after signup
  req.session.userId = newUser._id;

  res.redirect("/dashboard");

  });
  function isLoggedIn(req,res,next){

  if(req.session.userId){
    next();
  }else{
    res.render("login", { error: "⚠️ Please login first." });
  }

}

  app.get('/dashboard', isLoggedIn, (req, res) => {
    res.render('dashboard');
  });

  app.get("/summarize", isLoggedIn,async (req,res)=>{
    const summary = await Summary.findOne({ user: req.session.userId }).sort({ createdAt: -1 });
  res.render("summarize",{summary: null});
  });


  app.post("/summarize", upload.single("file"), async (req,res)=>{
  try {
  let text = "";
  if(!req.file){
  return res.send("No file uploaded");
  }
  const fileBuffer = req.file.buffer;
  const fileType = req.file.mimetype;
  if(fileType === "application/pdf"){
  const data = await pdfParse(fileBuffer);
  text = data.text;
  }
  else if(fileType.startsWith("image/")){
  const result = await Tesseract.recognize(fileBuffer,"eng");
  text = result.data.text;
  }
  else{
  return res.send("Unsupported file format");
  }
  text = text.slice(0,4000);
  const completion = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
  messages: [
  {
  role: "user",
  content: `Summarize this document in short bullet points:\n\n${text}`
  }
  ]
  });
  const summary = completion.choices[0].message.content;
  await Summary.create({
      filename: req.file.originalname,
  originalText: text,
  user: req.session.userId,
  summary: summary
  });

  res.render("summarize",{summary});
  }
  catch(err){
  console.log(err);
  res.send("Error summarizing file");
  }
  });

  app.get("/quiz",isLoggedIn,(req,res)=>{
    const quiz = Quiz.findOne({ user: req.session.userId }).sort({ createdAt: -1 });
  res.render("quiz",{quiz: null});
  }
  );
  app.post("/quiz", upload.single("file"), async (req, res) => {
  try {
    const fileBuffer = req.file.buffer;
  const pdfData = await pdfParse(fileBuffer);
  const text=pdfData.text.substring(0,4000);
  const response = await groq.chat.completions.create({
  model: "openai/gpt-oss-120b",
  messages: [
  {
  role: "user",
  content: `Generate summary and 5 quiz questions (with answers) from this text:\n\n${text}`
  }
  ],
  });
  const quiz = response.choices[0].message.content;
  await Quiz.create({
  filename: req.file.originalname,
  quizText: quiz,
  user: req.session.userId,
  });

  res.render("quiz",{quiz});
  } catch (error) {
  console.log(error);
  res.send("Error generating quiz");
  }
  });


  app.get("/doubt", isLoggedIn, (req, res) => {
    const doubt = Doubt.findOne({ user: req.session.userId }).sort({ createdAt: -1 });
    res.render("doubt", { answer: null, question: "" });
  });
  app.post("/doubt", isLoggedIn, async (req, res) => {

  try{

  const question = req.body.question;

  const prompt = `
  You are an AI tutor helping a student understand concepts clearly.

  Explain the following question in a structured and easy way.

  Use this format:
  ## Concept
  Explain the concept clearly in simple words.

  ## Key Points
  - Important idea 1
  - Important idea 2
  - Important idea 3

  ## Example
  Give a simple example if possible.

  ## Summary
  Short 1–2 line recap.

  Question:
  ${question}
  `;

  const response = await groq.chat.completions.create({
  messages:[{ role:"user", content: prompt }],
  model:"openai/gpt-oss-120b"
  });

  const answer = response.choices[0].message.content;
  await Doubt.create({
  question,
  answer,
  userId: req.session.userId
  });


  res.render("doubt",{ answer, question });

  }catch(err){

  console.log(err);
  res.send("Error generating answer");
  }
  });



  app.get("/notes",isLoggedIn,async (req, res) => {
    const summaries = await Summary.find({ user: req.session.userId }).sort({ createdAt: -1 });
    const quizzes = await Quiz.find({ user: req.session.userId }).sort({ createdAt: -1 });
    const doubts = await Doubt.find({ userId: req.session.userId }).sort({ createdAt: -1 });  

  res.render("notes", {
  summaries,
  quizzes,
  doubts
  });

  });


app.get("/flashcards", async (req, res) => {

    try {

        const cards = await Flashcard.find({ user: req.session.userId }).sort({ createdAt: -1 });

        res.render("flashcards", { cards });

    } catch (error) {

        console.log(error);
        res.send("Error loading flashcards");

    }

});


app.post("/flashcards", async (req, res) => {

    const text = req.body.text;
    try {

        const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
                {
                    role: "user",
                    content: `
Generate 5 flashcards from the following notes.
Format:
Question: ...
Answer: ...

Notes:
${text}`
                }
            ]
        });
        const output = completion.choices[0].message.content;
        const flashcards = [];
        const parts = output.split("Question:");
        parts.slice(1).forEach(part => {
            const q = part.split("Answer:")[0].trim();
            const a = part.split("Answer:")[1].trim();
            flashcards.push({
                question: q,
                answer: a
            });
        });
        for (const card of flashcards) {
            await Flashcard.create({
                question: card.question,
                answer: card.answer,
                user: req.session.userId
            });
        }
        res.redirect("/flashcards");
    } catch (error) {
        console.log(error);
        res.send("Error generating flashcards");
    }

});


app.get("/chat", isLoggedIn, (req,res)=>{
  const chats=chat.find({ user: req.session.userId }).sort({ createdAt: -1 });
res.render("chat", { chats });
});

app.post("/chat", async (req, res) => {

    const userMessage = req.body.message;

    try {

        // 1. Get previous chats
        const previousChats = await chat.find({
            user: req.session.userId
        })
        .sort({ createdAt: -1 })
        .limit(20);

        // Maintain correct order
        previousChats.reverse();


        // 2. Get uploaded PDF/image text
        const documentText = req.session.documentText || "";


        // 3. Create system prompt
        let systemPrompt = `
You are StudyMind AI, a smart student-friendly assistant.

Rules:
- Always give answers in clean format.
- Use headings and bullet points.
- Keep answers short and clear.
- Avoid long paragraphs.
- Make answers look like exam notes.
- Highlight keywords using bold.
- Explain difficult concepts in simple language.
`;


        // 4. If a document was uploaded, add it to the prompt
        if (documentText) {

            systemPrompt += `

The student has uploaded a PDF or image.

Use the uploaded document as the PRIMARY SOURCE for answering the student's questions.

UPLOADED DOCUMENT:
========================

${documentText}

========================

IMPORTANT RULES:

1. Answer the student's question based on the uploaded document.
2. If the student asks "explain this PDF", explain the important topics from the document.
3. If the student asks about a particular topic, find that topic in the document and explain it.
4. If the document contains code, explain the code from the document.
5. Do not invent information that is not present in the document.
6. If the answer cannot be found in the document, say:
   "I couldn't find this information in the uploaded document."
7. Explain the answer in simple student-friendly language.
`;
        }


        // 5. Create messages
        let messages = [
            {
                role: "system",
                content: systemPrompt
            }
        ];


        // 6. Add previous chat history
        previousChats.forEach(previousChat => {

            messages.push(
                {
                    role: "user",
                    content: previousChat.message
                },
                {
                    role: "assistant",
                    content: previousChat.response
                }
            );

        });


        // 7. Add current question
        messages.push({
            role: "user",
            content: userMessage
        });


        // 8. Call Groq
        const completion = await groq.chat.completions.create({

            model: "openai/gpt-oss-120b",

            messages: messages,

            temperature: 0.7

        });


        // 9. Get response
        const reply = completion.choices[0].message.content;


        // 10. Save chat
        await chat.create({

            message: userMessage,

            response: reply,

            user: req.session.userId

        });


        // 11. Send response
        res.json({
            reply: reply
        });


    } catch (err) {

        console.log(err);

        res.status(500).send("AI Error");

    }

});
app.post("/upload-document", upload.single("file"), async (req, res) => {

    try {

        if (!req.file) {
            return res.status(400).json({
                error: "No file uploaded"
            });
        }

        let extractedText = "";

        if (req.file.mimetype === "application/pdf") {

            const data = await pdfParse(req.file.buffer);

            extractedText = data.text;

        } else if (req.file.mimetype.startsWith("image/")) {

            const result = await Tesseract.recognize(
                req.file.buffer,
                "eng"
            );

            extractedText = result.data.text;

        } else {

            return res.status(400).json({
                error: "Only PDF and image files are supported"
            });

        }

        extractedText = extractedText.trim();

        if (!extractedText) {
            return res.status(400).json({
                error: "Could not extract text"
            });
        }

        // ⭐ THIS IS IMPORTANT
        req.session.documentText = extractedText;

        res.json({
            success: true,
            filename: req.file.originalname
        });

    } catch (error) {

        console.log(error);

        res.status(500).json({
            error: "Error processing document"
        });

    }

});  app.get("/logout",(req,res)=>{
  req.session.destroy(()=>{
  res.redirect("/");
  });

  });

  app.listen(port, () => {
    console.log(`Example app listening at http://:${port}`);
  });
