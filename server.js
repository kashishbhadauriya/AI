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
  model: "llama-3.3-70b-versatile",
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
  model: "llama-3.3-70b-versatile",
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
  model:"llama-3.1-8b-instant"
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
            model: "llama-3.1-8b-instant",
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

    // ✅ 1. Get LAST chats (important)
    const previousChats = await chat.find({ user: req.session.userId })
      .sort({ createdAt: -1 })   // latest first
      .limit(20);                // more context

    // reverse to maintain correct order
    previousChats.reverse();

    // ✅ 2. Strong SYSTEM PROMPT
    let messages = [
      {
        role: "system",
   content: `
You are StudyMind AI, a smart student-friendly assistant.

Rules:
- Always give answers in clean format
- Use headings and bullet points
- Keep answers short and clear
- Avoid long paragraphs
- Make answers look like exam notes
- Highlight keywords using bold
- Structure like:

Definition
Then points
Then types

Never give long paragraph explanations unless asked.
`
      }
    ];

    // ✅ 3. Add history properly
    previousChats.forEach(chat => {
      messages.push(
        { role: "user", content: chat.message },
        { role: "assistant", content: chat.response }
      );
    });

    // ✅ 4. Add current message
    messages.push({
      role: "user",
      content: userMessage
    });

    // ✅ 5. Call AI
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "user",
          content: userMessage
        }
      ]
      messages: messages,
      temperature: 0.7   // more natural responses
    });

    const reply = completion.choices[0].message.content;

    // ✅ 6. Save
    await chat.create({
      message: userMessage,
      response: reply,
      user: req.session.userId
    });

    res.json({ reply });

  } catch (err) {
    console.log(err);
    res.status(500).send("AI Error");
  }

});


  app.get("/logout",(req,res)=>{
  req.session.destroy(()=>{
  res.redirect("/");
  });

  });

  app.listen(port, () => {
    console.log(`Example app listening at http://:${port}`);
  });
