# <img src="logo.svg" width="48"> Telegram Services

**telegram.services** is a Kilroy applicappation that implements a chat_agent widget for use with kilroy.ai.services pipelines.

It handles all of the necessary set-up and communications with a Telegram chat bot assigned to a specific chat room. In order to use this
app/agent effectively with Kilroy pipelines, you should already have a Telegram bot defined and have an appropriate API key for the bot.

## Getting Started
All of the configuration details are provided in the inspector for the agent in the Kilroy AI Pipeline Editor. When inspecting the agent's diagram
block, you should make sure to edit the JSON configuration object and supply the bot's API key. In addition, if you know the chat room ID, you can fill
it in as well. If you leave it set to "0", Kilroy will fill in the chat ID using the first message the bot receives after it starts running.

In all other respects, this chat_agent will act like the built-in kilroy.ai.services chat_agent, except that all input and output will be with Telegram
and whatever Telegram app the user is communicating through, rather than a scrolling chat window in the Kilroy browser UI, like the default chat_agent.