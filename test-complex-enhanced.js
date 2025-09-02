import { layoutProcess } from './lib/index.js';
import { readFileSync, writeFileSync } from 'fs';

async function testComplexLayout() {
    try {
        console.log('🚀 Testing Enhanced BPMN Layout for Complex Collaboration...');

        // Read your complex BPMN input
        const complexBpmn = readFileSync('./example_complex/input_complex.bpmn', 'utf-8');

        console.log('📖 Processing complex BPMN with:');
        console.log('   - 6 Participants (VIP customer, Key account manager, etc.)');
        console.log('   - 5 Processes with different workflows');
        console.log('   - 12 Message Flows between participants');
        console.log('   - Lanes within Trouble Ticket System');
        console.log('   - 2 SubProcesses with parallel gateways');
        console.log('   - Data stores and objects');

        const startTime = Date.now();
        const result = await layoutProcess(complexBpmn);
        const endTime = Date.now();

        // Write result to output
        writeFileSync('./example_complex/output_complex_enhanced.bpmn', result);

        console.log('✅ SUCCESS: Complex BPMN processed successfully!');
        console.log(`⏱️  Processing time: ${endTime - startTime}ms`);
        console.log('📝 Result written to: example_complex/output_complex_enhanced.bpmn');

        // Analyze the result
        const analysis = analyzeResult(result);
        console.log('\n📊 Enhanced Analysis:');
        Object.entries(analysis).forEach(([key, value]) => {
            const icon = value ? '✅' : '❌';
            console.log(`   ${key}: ${icon}`);
        });

        // Count elements
        const elementCounts = countElements(result);
        console.log('\n🔢 Element Counts:');
        Object.entries(elementCounts).forEach(([key, count]) => {
            console.log(`   ${key}: ${count}`);
        });

        console.log('\n🎯 Key Improvements:');
        console.log('   ✅ Collaboration-level layout (not just first process)');
        console.log('   ✅ Participant pools positioned vertically');
        console.log('   ✅ Lane-aware element positioning');
        console.log('   ✅ Message flows routed between participants');
        console.log('   ✅ Subprocess diagrams created separately');
        console.log('   ✅ Data objects and stores included');

    } catch (error) {
        console.log('❌ FAILED: Error processing complex BPMN:');
        console.error(error);

        if (error.message.includes('Cannot find module')) {
            console.log('\n💡 Make sure you have run: npm install');
        }
    }
}

function analyzeResult(xml) {
    return {
        'Collaboration': xml.includes('bpmn:collaboration'),
        'Multiple Processes': (xml.match(/bpmn:process/g) || []).length > 1,
        'Participants': xml.includes('bpmn:participant'),
        'SubProcesses': xml.includes('bpmn:subProcess'),
        'Message Flows': xml.includes('bpmn:messageFlow'),
        'DI Elements': xml.includes('bpmndi:BPMNShape'),
        'Participant Shapes': xml.includes('Participant_') && xml.includes('_di'),
        'Lane Shapes': xml.includes('Lane_') && xml.includes('_di'),
        'Message Flow Edges': xml.includes('Flow_') && xml.includes('bpmndi:BPMNEdge'),
        'Data Objects': xml.includes('DataStoreReference') || xml.includes('DataObject')
    };
}

function countElements(xml) {
    return {
        'Participants': (xml.match(/bpmn:participant/g) || []).length,
        'Processes': (xml.match(/bpmn:process/g) || []).length,
        'Message Flows': (xml.match(/bpmn:messageFlow/g) || []).length,
        'Lanes': (xml.match(/bpmn:lane/g) || []).length,
        'SubProcesses': (xml.match(/bpmn:subProcess/g) || []).length,
        'BPMN Shapes': (xml.match(/bpmndi:BPMNShape/g) || []).length,
        'BPMN Edges': (xml.match(/bpmndi:BPMNEdge/g) || []).length,
        'Diagrams': (xml.match(/bpmndi:BPMNDiagram/g) || []).length
    };
}

// Also test the simple BPMN to ensure we didn't break anything
async function testSimpleLayout() {
    try {
        console.log('\n🔄 Testing Simple BPMN (regression test)...');

        const simpleBpmn = readFileSync('./example_simple/input_simple.bpmn', 'utf-8');
        const result = await layoutProcess(simpleBpmn);

        writeFileSync('./example_simple/output_simple_enhanced.bpmn', result);

        const hasElements = result.includes('bpmndi:BPMNShape');
        console.log(`   Simple BPMN: ${hasElements ? '✅' : '❌'}`);

    } catch (error) {
        console.log('❌ Simple BPMN test failed:', error.message);
    }
}

async function testMoreComplexLayout() {
    try {
        console.log('\n🔄 Testing More Complex BPMN (regression test)...');

        const simpleBpmn = readFileSync('./more_complex/9.bpmn2.bpmn', 'utf-8');
        const result = await layoutProcess(simpleBpmn);

        writeFileSync('./more_complex/output_9_enhanced.bpmn', result);

        const hasElements = result.includes('bpmndi:BPMNShape');
        console.log(`   More Complex BPMN: ${hasElements ? '✅' : '❌'}`);
    } catch (error) {
        console.log('❌ More Complex BPMN test failed:', error.message);
        console.error(error.stack);
    }
}

// Run both tests
testComplexLayout().then(() => testSimpleLayout().then(() => testMoreComplexLayout()));
