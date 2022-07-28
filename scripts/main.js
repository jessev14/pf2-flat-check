const moduleID = 'pf2-flat-check';

const actorConditionMap = {
    'Dazzled': 5,
    'Blinded': 11
};
const targetConditionMap = {
    'Concealed': 5,
    'Hidden': 11
};


Hooks.once("init", () => {
    game.settings.register(moduleID, 'hideRollValue', {
        name: 'Show "Success" or "Failure" Text',
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });
});


Hooks.on('createChatMessage', async (message, data, userID) => {
    if (game.user.id !== game.users.find(u => u.isGM && u.active).id) return;

    const { token, item, actor } = message;
    if (!item || !actor) return;
    if (item.type === 'weapon' && (!message.isRoll || message.isDamageRoll)) return;
    if (item.type === 'spell' && message.isRoll) return;
    
    const templateData = {};
    const { conditionName, DC } = getCondition(actor, true, item.type === 'spell');
    templateData.flatCheckDC = DC ?? 0;
    templateData.actor = { name: token?.name || actor.name, condition: conditionName };

    templateData.targets = [];
    const targets = Array.from(game.users.get(userID).targets);
    for (const target of targets) {
        const { conditionName, DC } = getCondition(target.actor, false, item.type === 'spell');
        if (!conditionName) continue;

        templateData.targets.push({
            name: target.name,
            condition: conditionName
        });
        
        if (DC > templateData.flatCheckDC) templateData.flatCheckDC = DC;
    }

    if (!templateData.actor.condition && !templateData.targets.length) return;

    const flatCheckRoll = await new Roll('1d20').roll();
    if (game.dice3d) await game.dice3d.showForRoll(flatCheckRoll, game.users.get(userID), true);

    templateData.flatCheckRollResult = !game.settings.get(moduleID, 'hideRollValue')
        ? flatCheckRoll.result
        : flatCheckRoll.result < templateData.flatCheckDC
            ? 'Failure'
            : 'Success';
        
    templateData.flatCheckRollResultClass =
        flatCheckRoll.result < templateData.flatCheckDC
            ? 'flat-check-failure'
            : 'flat-check-success';

    const content = await renderTemplate(`modules/${moduleID}/templates/flat-check.hbs`, templateData);
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ token, actor, user: game.users.get(userID) }),
        content
    });
});


function getCondition(actor, isAttacker, isSpell) {
    const conditionMap = isAttacker ? { ...actorConditionMap } : targetConditionMap;

    const conditions = actor.itemTypes.condition
        .filter(c => {
            if (isAttacker && isSpell) {
                const isStupefy = c.name === game.i18n.localize('PF2E.ConditionTypeStupefied');
                if (isStupefy) return true;
            }
            return Object.keys(conditionMap).includes(c.name);
        })
        .map(c => c.name);
    if (!conditions.length) return {};

    let stupefyLevel;
    if (conditions.includes(game.i18n.localize('PF2E.ConditionTypeStupefied'))) {
        stupefyLevel = actor.itemTypes.condition.find(c => c.name === game.i18n.localize('PF2E.ConditionTypeStupefied'))?.value;
        if (stupefyLevel) conditionMap['Stupefied'] = stupefyLevel + 5;
    }

    let condition = conditions.reduce((acc, current) => conditionMap[acc] > conditionMap[current] ? acc : current);
    const DC = conditionMap[condition];
    if (condition === 'Stupefied') condition += ` ${stupefyLevel}`;

    return { conditionName: condition, DC };
}
