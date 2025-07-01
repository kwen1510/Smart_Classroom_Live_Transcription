# Smart Classroom Live Transcription - Render Deployment

This is the deployment-ready version of the Smart Classroom Live Transcription system for Render.com.

## 🚀 Quick Deploy to Render

### Option 1: Deploy with Render Dashboard (Recommended)

1. **Fork or clone this repository** to your GitHub account
2. **Go to [Render Dashboard](https://dashboard.render.com)**
3. **Click "New +" → "Web Service"**
4. **Connect your GitHub repository**
5. **Configure the service:**
   - **Name**: `smart-classroom-transcription`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Plan**: `Starter` (free tier)

6. **Add Environment Variables:**
   - `ELEVENLABS_KEY` - Your ElevenLabs API key
   - `ANTHROPIC_KEY` - Your Anthropic Claude API key
   - `NODE_ENV` - `production`
   - `PORT` - `10000` (Render will override this)

7. **Click "Create Web Service"**

### Option 2: Deploy with render.yaml (Blue-Green)

1. **Push this code to GitHub**
2. **Go to Render Dashboard**
3. **Click "New +" → "Blueprint"**
4. **Connect your repository**
5. **Render will automatically detect the `render.yaml` file**
6. **Add your API keys in the environment variables section**
7. **Click "Apply"**

## 🔧 Environment Variables

You need to set these environment variables in your Render dashboard:

| Variable | Description | Required |
|----------|-------------|----------|
| `ELEVENLABS_KEY` | Your ElevenLabs API key for transcription | ✅ |
| `ANTHROPIC_KEY` | Your Anthropic Claude API key for summarization | ✅ |
| `NODE_ENV` | Environment (set to `production`) | ✅ |
| `PORT` | Port number (Render sets this automatically) | ❌ |

## 📋 Requirements

- **Node.js**: Version 18.20.5 (specified in package.json)
- **npm**: Latest version
- **API Keys**: ElevenLabs and Anthropic Claude

## 📁 Project Structure

```
render-deployment/
├── index.js              # Main server file
├── package.json          # Dependencies and scripts
├── render.yaml           # Render configuration
├── .env                  # Local environment variables (not used in production)
├── README.md            # This file
└── public/              # Static files
    ├── admin.html       # Teacher dashboard
    ├── student.html     # Student interface
    ├── test-transcription.html
    └── ...
```

## 🌐 Accessing Your App

After deployment, your app will be available at:
- **Main URL**: `https://your-app-name.onrender.com`
- **Teacher Dashboard**: `https://your-app-name.onrender.com/admin`
- **Student Interface**: `https://your-app-name.onrender.com/student`
- **History Page**: `https://your-app-name.onrender.com/history`

## 💰 Costs

- **Free Tier**: 750 hours/month (enough for most use cases)
- **Paid Plans**: Start at $7/month for unlimited usage
- **API Costs**: You pay for ElevenLabs and Anthropic API usage separately

## 🔄 Updates

To update your deployed app:
1. **Push changes to your GitHub repository**
2. **Render will automatically redeploy** (if auto-deploy is enabled)
3. **Or manually trigger a deploy** from the Render dashboard

## 🛠️ Local Development

To run locally before deploying:

```bash
cd render-deployment
npm install
cp .env.example .env  # Create your .env file
# Edit .env with your API keys
npm start
```

## 🐛 Troubleshooting

### Common Issues:

1. **Build fails**: Check that all dependencies are in `package.json`
2. **App crashes**: Check the logs in Render dashboard
3. **API errors**: Verify your API keys are set correctly
4. **Database issues**: SQLite file is created automatically

### Logs:
- **View logs** in the Render dashboard under your service
- **Real-time logs** are available during deployment

## 📞 Support

If you encounter issues:
1. **Check Render documentation**: https://render.com/docs
2. **View application logs** in Render dashboard
3. **Verify environment variables** are set correctly
4. **Test locally** first to isolate issues

## 🔒 Security Notes

- **API keys** are stored securely in Render environment variables
- **Database** (SQLite) is ephemeral on free tier - data may be lost on restarts
- **HTTPS** is automatically enabled on Render
- **No sensitive data** should be committed to the repository

---

**Happy Teaching! 🎓** 