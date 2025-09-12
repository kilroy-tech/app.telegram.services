/* pipeline_editor_impl.js */

go.licenseKey = "73ff41e0b61c28c702d95d76423d38f919a57f63c9851fa30a0440f6ba08381d2a98bd7152d78ad2c2fe46af497d948a8f926f2a944c0032b736d1d540e686feb63773b5120a42ddf7072290cbf97da6fe7126a790b124f2db7c8de0fbae96cc5ae8a18449d81eb828780f2e5261ac4a";

function safeStringify (value) {
	const seen = new Set();
	return JSON.stringify(value, (k, v) => {
		if (seen.has(v)) { return '...' }
		if (typeof v === 'object') { seen.add(v) }
		return v;
	},4);
}


//-------------------------------------------------------------------------

const PD_PADDING_PX = 16;
const CONTROL_SIZE = 8;

let _editMode = true;
const _shadowColor = "#303030";

const $go = go.GraphObject.make;

const paletteDiv = "pd-palette-area-";

let myPalettes = [];
    myPalettes[0] = $go(go.Palette, paletteDiv+"1",  // must name or refer to the DIV HTML element
        {
            scrollsPageOnFocus: false,
            initialContentAlignment: go.Spot.Center,
        }
    );

let myDiagram = myPalettes[0]; //fake out all the model object code to avoid refactoring it

//-------------------------------------------------------------------------

function linkTooltipInfo(d) { // Tooltip info for a link data object
    return "Link:\nfrom " + d.from + " to " + d.to;
}

myDiagram.linkTemplate = new go.Link({
        // shadow options are for the label, not the link itself
        isShadowed: true,
        shadowBlur: 12,
        shadowColor: _shadowColor,
        shadowOffset: new go.Point(2.5, 2.5),

        curve: go.Curve.Bezier,
        curviness: 40,
        adjusting: go.LinkAdjusting.Stretch,
        reshapable: true,
        relinkableFrom: true,
        relinkableTo: true,
        fromShortLength: 8,
        toShortLength: 10,
        zOrder: 120,
        layerName: "Foreground"
    })
    .bindTwoWay('points')
    .bind('curviness')
    .bind('zOrder')
    .add(
    // Main shape geometry
    new go.Shape({ strokeWidth: 2, shadowVisible: false, /*stroke: 'black' */ })
        .bindObject('stroke', 'fromPort', (p) => (p.portId == "CONTROL_OUT") ? "red" : "black")
        .bindObject('strokeDashArray', 'fromPort', (p) => (p.portId=="CONTROL_OUT" ? [5,6] : []))
        .bind('opacity', 'progress', (progress) => (progress ? 1 : 0.5)),
    // Arrowheads
    new go.Shape({ fromArrow: 'circle', strokeWidth: 1.5, fill: 'white' }).bindObject('stroke', 'fromPort', (p) => (p.portId == "CONTROL_OUT") ? "red" : "black"),
    new go.Shape({ toArrow: 'standard', stroke: null, scale: 1.5 }).bindObject('fill', 'fromPort', (p) => (p.portId == "CONTROL_OUT") ? "red" : "black"),
    // The link label
    new go.Panel('Auto')
        .add(
        new go.Shape('RoundedRectangle', {
            shadowVisible: true,
//            fill: '#faeb98',
            strokeWidth: 0.5
        }).bindObject('fill', 'fromPort', (p) => (p.portId == "CONTROL_OUT") ? "white" : "#faeb98"),
        new go.TextBlock({
            font: '9pt helvetica, arial, sans-serif',
            margin: 1,
            editable: true, // enable in-place editing
            text: 'Agent_Name' // default text
        }).bindTwoWay('text', 'agent_name')
        // editing the text automatically updates the model data
        )
    );

//-------------------------------------------------------------------------

function _fillOrGrad (v) {
    try {
        var grad = JSON.parse (v);
        var brush = "Linear";
        if (grad.hasOwnProperty ("brush")) {
            brush = grad.brush;
            grad = grad.gradient;
        }
        return go.GraphObject.make(go.Brush, brush, grad);
    }
    catch (err) {
        return v;
    }
    return v;
}

function portStyle(id, input, align) {
    return (graphObj) => {
        graphObj.bindTwoWay('alignment', id + 'Spot', go.Spot.parse, go.Spot.stringify)

        Object.assign(graphObj, {
            portId: id,
            desiredSize: new go.Size(CONTROL_SIZE, CONTROL_SIZE+4),
            alignment: align,
            stroke: 'black',
            fill: '#0D6EFD', //blue',
//            fromSpot: go.Spot.Left,
            fromLinkable: !input,
//            toSpot: go.Spot.Top,
            toLinkable: input,
            fromMaxLinks: 1,
//            toMaxLinks: 1,
            cursor: 'pointer'
        });
    };
}


function agentTooltipInfo(d) { // Tooltip info for agent objects
    if (d.category=="swarm") {
        return d.swarm_desc;
    }
    else {
        return d.agent_desc;
    }
}

myDiagram.nodeTemplateMap.add('ai_agent',
    $go(go.Node, "Table", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: true,
            shadowBlur: 12,
            shadowColor: _shadowColor,
            shadowOffset: new go.Point(2.5, 2.5),
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY",
                row: 0,
                column: 0,
                stretch: go.Stretch.fill
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape,
                new go.Binding ("figure"),
                new go.Binding ("fill","fill", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("opacity"),
                {
                    portId: "DATA",
                    cursor: "pointer",
                    fromLinkable: true,
                    fromLinkableSelfNode: false,
                    fromLinkableDuplicates: false,
                    toLinkable: true,
                    toLinkableSelfNode: false,
                    toLinkableDuplicates: false,
                    toMaxLinks: 1,
                    fromMaxLinks: 1
                }
            ),
            $go(go.TextBlock,
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "agent_name").makeTwoWay()                
            ),
            { // this tooltip Adornment is shared by all agents
                toolTip: $go(go.Adornment, "Auto",
                    $go(go.Shape, {
                        fill: "#FFFFCC"
                    }),
                    $go(go.TextBlock, {
                            margin: 4
                        }, // the tooltip shows the result of calling workflowTooltipInfo(data)
                        new go.Binding("text", "", agentTooltipInfo))
                )
            }

        ),
        $go(go.Panel, "Vertical", {
                name: "PORT",
                row: 0,
                column: 1,
                margin: new go.Margin(0, 0, 0, CONTROL_SIZE/2),
            },
            //control output port
            new go.Shape('TriangleLeft').apply(portStyle('CONTROL_IN', true, new go.Spot(0, 0.5)))
        )

    )
);


//-------------------------------------------------------------------------

myDiagram.nodeTemplateMap.add('wf_agent',
    $go(go.Node, "Table", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: true,
            shadowBlur: 12,
            shadowColor: _shadowColor,
            shadowOffset: new go.Point(2.5, 2.5),
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a Rectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY",
                row: 0,
                column: 1,
                stretch: go.Stretch.fill
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape,
                new go.Binding ("figure"),
                new go.Binding ("fill","fill", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("opacity"),
                {
                    portId: "DATA",
                    cursor: "pointer",
                    fromLinkable: true,
                    fromLinkableSelfNode: false,
                    fromLinkableDuplicates: false,
                    toLinkable: true,
                    toLinkableSelfNode: false,
                    toLinkableDuplicates: false,
                    toMaxLinks: 1,
                    fromMaxLinks: 1
                }
            ),
            $go(go.TextBlock,
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "agent_name").makeTwoWay(),
            ),
            { // this tooltip Adornment is shared by all agents
                toolTip: $go(go.Adornment, "Auto",
                    $go(go.Shape, {
                        fill: "#FFFFCC"
                    }),
                    $go(go.TextBlock, {
                            margin: 4
                        }, // the tooltip shows the result of calling workflowTooltipInfo(data)
                        new go.Binding("text", "", agentTooltipInfo))
                )
            }
        ),
        $go(go.Panel, "Vertical", {
                name: "PORT",
                row: 0,
                column: 0,
                margin: new go.Margin(0, CONTROL_SIZE-2, 0, 0),
            },
            //control output port
            new go.Shape('TriangleRight').apply(portStyle('CONTROL_IN', true, new go.Spot(0, 0.5))).bind("visible", "agent_is_controlled"),
            new go.Shape('TriangleLeft').apply(portStyle('CONTROL_OUT', false, new go.Spot(0, 0.5))).bind("visible", "agent_is_controller"),
//            new go.Binding ("visible", "agent_is_controller")
        )

    )
);


//-------------------------------------------------------------------------

myDiagram.nodeTemplateMap.add('viewer_agent',
    $go(go.Node, "Auto", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: true,
            shadowBlur: 12,
            shadowColor: _shadowColor,
            shadowOffset: new go.Point(2.5, 2.5),
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY"
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape,
                new go.Binding ("figure"),
                new go.Binding ("fill","fill", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("opacity"),
                {
                    portId: "DATA",
                    cursor: "pointer",
                    fromLinkable: false,
                    fromLinkableSelfNode: false,
                    fromLinkableDuplicates: false,
                    toLinkable: true,
                    toLinkableSelfNode: false,
                    toLinkableDuplicates: false,
                    toMaxLinks: 1,
                    fromMaxLinks: 1
                }
            ),
            $go(go.TextBlock,
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "agent_name").makeTwoWay()
            ),
            { // this tooltip Adornment is shared by all agents
                toolTip: $go(go.Adornment, "Auto",
                    $go(go.Shape, {
                        fill: "#FFFFCC"
                    }),
                    $go(go.TextBlock, {
                            margin: 4
                        }, // the tooltip shows the result of calling workflowTooltipInfo(data)
                        new go.Binding("text", "", agentTooltipInfo))
                )
            }

        )
    )
);

//-------------------------------------------------------------------------

myDiagram.nodeTemplateMap.add('chat_agent',
    $go(go.Node, "Auto", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: true,
            shadowBlur: 12,
            shadowColor: _shadowColor,
            shadowOffset: new go.Point(2.5, 2.5),
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY"
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape,
                new go.Binding ("figure"),
                new go.Binding ("fill","fill", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("opacity"),
                {
                    portId: "DATA",
                    cursor: "pointer",
                    fromLinkable: true,
                    fromLinkableSelfNode: false,
                    fromLinkableDuplicates: false,
                    toLinkable: true,
                    toLinkableSelfNode: false,
                    toLinkableDuplicates: false,
                    toMaxLinks: 1,
                    fromMaxLinks: 1
                }
            ),
            $go(go.TextBlock,
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "agent_name").makeTwoWay(),
            ),
            { // this tooltip Adornment is shared by all agents
                toolTip: $go(go.Adornment, "Auto",
                    $go(go.Shape, {
                        fill: "#FFFFCC"
                    }),
                    $go(go.TextBlock, {
                            margin: 4
                        }, // the tooltip shows the result of calling workflowTooltipInfo(data)
                        new go.Binding("text", "", agentTooltipInfo))
                )
            }

        )
    )
);


//-------------------------------------------------------------------------

myDiagram.nodeTemplateMap.add('swarm',
    $go(go.Node, "Auto", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: true,
            shadowBlur: 12,
            shadowColor: _shadowColor,
            shadowOffset: new go.Point(2.5, 2.5),
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY"
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape,
                new go.Binding ("figure"),
                new go.Binding ("fill","fill", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("opacity"),
                {
                    portId: "DATA",
                    cursor: "pointer",
                    fromLinkable: true,
                    fromLinkableSelfNode: false,
                    fromLinkableDuplicates: false,
                    toLinkable: true,
                    toLinkableSelfNode: false,
                    toLinkableDuplicates: false
                }
            ),
            $go(go.TextBlock,
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "swarm_name").makeTwoWay()
            ),
            $go(go.Picture, {
                    source:"images/kilroy.svg", 
                    width:40, 
                    height: 30, 
                    imageStretch: go.ImageStretch.Uniform,
                    alignmentFocus: go.Spot.TopLeft,
                    alignment: new go.Spot (0,0,0,-6)
                },
                new go.Binding ("visible", "swarm_is_public")
            ),
            { // this tooltip Adornment is shared by all agents
                toolTip: $go(go.Adornment, "Auto",
                    $go(go.Shape, {
                        fill: "#FFFFCC"
                    }),
                    $go(go.TextBlock, {
                            margin: 4
                        }, // the tooltip shows the result of calling workflowTooltipInfo(data)
                        new go.Binding("text", "", agentTooltipInfo))
                )
            }

        )
    )
);


//-------------------------------------------------------------------------

var commentFill = "#FEF9A8";
var commentStroke = "#aaaaaa";

// template for comment nodes

myDiagram.nodeTemplateMap.add('comment',
    $go(go.Node, "Auto", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true
        },
        new go.Binding("visible", "visible", function (x) { return _editMode}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY"
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape, "Rectangle", {
                strokeWidth: 1,
                stroke: commentStroke,
                fill: commentFill
            }),
            $go(go.TextBlock, {
                    font: "12px \"Helvetica Neue\", Helvetica, Arial, sans-serif",
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "msg").makeTwoWay()
            )
        )
    )
);



//-------------------------------------------------------------------------
myDiagram.nodeTemplateMap.add('graphic',
    $go(go.Node, "Auto", {
            selectionObjectName: "BODY",
            resizable: true,
            resizeObjectName: "BODY",
            deletable: true,
            isShadowed: false,
            layerName: "Background"
        },
        new go.Binding("angle").makeTwoWay(),
        new go.Binding ("rotatable", "angle", function (x) { return _editMode;}),
        new go.Binding ("rotationSpot", "angle", function (x) {return go.Spot.Center;}),
        new go.Binding ("selectable", "loc", function (x) { return _editMode;}),
        new go.Binding("location", "loc", go.Point.parse).makeTwoWay(go.Point.stringify),
        new go.Binding ("zOrder"),

        // the main "BODY" consists of a RoundedRectangle surrounding nested Panels
        $go(go.Panel, "Auto", {
                name: "BODY",
                row: 0,
                column: 0,
                stretch: go.Stretch.fill
            },
            new go.Binding("desiredSize", "rsize", go.Size.parse).makeTwoWay(go.Size.stringify),
            $go(go.Shape, 
                new go.Binding ("figure"),
                new go.Binding ("fill","fillColor", _fillOrGrad),
                new go.Binding ("stroke"),
                new go.Binding ("strokeWidth"),
                new go.Binding ("strokeDashArray", "dash"),
                new go.Binding ("opacity"),
            ),
            $go(go.TextBlock, 
                new go.Binding ("font"),
                new go.Binding ("stroke", "fontStroke"),
                new go.Binding ("opacity"),
                {
                    margin: 6,
                    isMultiline: true, // don't allow newlines in text
                    editable: true // allow in-place editing by user
                },
                new go.Binding("text", "msg").makeTwoWay()
            )

        )
    )
);


//-------------------------------------------------------------------------
function SetupPalettes (div, myDiagram) {
    let $go = go.GraphObject.make;

    myPalettes[0].model = new go.GraphLinksModel(palette_defs.wf_palette); //from palette_defs.js
    myPalettes[0].commandHandler = new LocalStorageCommandHandler();
    /*
    myPalettes[1] = $go(go.Palette, paletteDiv+"2",  // must name or refer to the DIV HTML element
        {
            scrollsPageOnFocus: false,
//                allowHorizontalScroll: false,
                allowVerticalScroll: true,
            nodeTemplateMap: myDiagram.nodeTemplateMap,  // share the templates used by myDiagram
            linkTemplateMap: myDiagram.linkTemplateMap,
            initialContentAlignment: go.Spot.Center,
            model: new go.GraphLinksModel(palette_defs.wf_palette) //from palette_defs.js
        }
    );
    myPalettes[1].commandHandler = new LocalStorageCommandHandler();
    */

}

//-------------------------------------------------------------------------
//-- set up tooltips
$(function () {
    $('[data-toggle="tooltip"]').tooltip()
})


function windowResized () {
}

window.addEventListener ("resize", windowResized);

windowResized ();

SetupPalettes (paletteDiv, myDiagram);
