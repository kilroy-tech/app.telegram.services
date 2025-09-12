const palette_defs = {

//==============================================================================================

    wf_palette: [

                {
                    category: "chat_agent",
                    figure: "ControlCenter",
                    agent_name: "Telegram",
                    agent_desc: "Input/output agent for Telegram",
                    agent_display_order: 1,
                    agent_is_controlled: false,
                    agent_width : 512, 
                    agent_height : 512,
                    agent_style : 2,
                    wf_agent_name : "Telegram",
                    wf_username : "Telegram",
                    wf_diagram_alias : "telegram.services.config",
                    wf_webhook_args : "{\"bot_key\":\"XXX\",\"chat_id\":\"0\", \"markdown\": true}",
                    rsize: "88 60",
                    angle: "0",
                    fill: "#FFFFFF",
                    opacity: 1.0,
                    stroke: "#32A9DF",
                    strokeWidth: 1,
                    font: "12px \"Helvetica Neue\", Helvetica, Arial, sans-serif",
                    fontStroke : "#32A9DF",
                    zOrder: 100
                }
        
        ]
};

console.log ("palettes loaded");